import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("tradex_engine", Path(__file__).parents[1] / "engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def request(asset="crypto", mode="snapshot", symbol="BTC-USD", **kwargs):
    return {"symbol": symbol, "assetType": asset, "horizon": "month", "engine": mode, **kwargs}


def yahoo(symbol="BTC-USD", instrument_type="CRYPTOCURRENCY", days=90, stale=False):
    now = int(datetime.now(timezone.utc).timestamp()) - (10 * 86400 if stale else 0)
    return {"chart": {"result": [{"meta": {"symbol": symbol, "currency": "USD", "instrumentType": instrument_type, "longName": "Bitcoin", "exchangeName": "CCC"},
        "timestamp": [now - (days - 1 - i) * 86400 for i in range(days)],
        "indicators": {"quote": [{"close": [100 + i for i in range(days)]}]}}]}}


def coin(symbol="btc", coin_id="bitcoin"):
    return {"id": coin_id, "symbol": symbol, "name": "Bitcoin", "last_updated": engine.now_iso(), "market_data": {
        "current_price": {"usd": 200}, "market_cap": {"usd": 123456789}, "fully_diluted_valuation": {"usd": 150000000},
        "circulating_supply": 19000000, "total_supply": 20000000, "max_supply": None}}


def fake_fetch(url, headers=None):
    if "finance.yahoo" in url:
        return yahoo()
    if "/search?" in url:
        return {"coins": [{"symbol": "btc", "id": "bitcoin"}]}
    return coin()


class EvidenceTests(unittest.TestCase):
    def test_chain_activity_requires_exact_coin_identity_and_labels_retrieval_time(self):
        report = {"sources": [], "metrics": [], "sections": [], "coverage": []}
        chains = [{"gecko_id": "ethereum", "name": "Ethereum", "tvl": 1000}, {"gecko_id": "unrelated", "name": "Other", "tvl": 9999}]
        engine.collect_chain_activity(report, "ethereum", lambda *args: chains)
        self.assertEqual(len(report["metrics"]), 1)
        self.assertEqual(report["metrics"][0]["label"], "Ethereum DeFi TVL (USD)")
        self.assertEqual(report["sources"][0]["timestampBasis"], "retrieval")
        other = {"sources": [], "metrics": [], "sections": [], "coverage": []}
        engine.collect_chain_activity(other, "bitcoin", lambda *args: chains)
        self.assertEqual(other["sources"], [])
        self.assertEqual(other["coverage"][0]["status"], "missing")
    def test_snapshot_has_replayable_evidence_without_ai_recommendation(self):
        report = engine.build_report(request(), fake_fetch)
        self.assertEqual(report["usage"]["llmCalls"], 0)
        self.assertTrue(all(s["kind"] == "evidence" for s in report["sections"]))
        ids = {s["id"] for s in report["sources"]}
        self.assertTrue(all(m["sourceId"] in ids for m in report["metrics"]))
        self.assertNotIn("Maximum supply", [m["label"] for m in report["metrics"]])
        for source in report["sources"]:
            self.assertEqual(hashlib.sha256(source["snapshot"].encode()).hexdigest(), source["sha256"])
            json.loads(source["snapshot"])

    def test_crypto_ticker_ambiguity_requires_explicit_identity(self):
        def fetch(url, headers=None):
            return {"coins": [{"symbol": "btc", "id": "one"}, {"symbol": "btc", "id": "two"}]} if "/search?" in url else fake_fetch(url)
        with self.assertRaises(engine.ResearchFailure) as raised:
            engine.build_report(request(), fetch)
        self.assertEqual(raised.exception.code, "AMBIGUOUS_COIN")
        self.assertEqual(engine.build_report(request(coinId="bitcoin"), fetch)["sources"][1]["provider"], "CoinGecko")

    def test_mismatched_provider_identity_never_publishes_report(self):
        def fetch(url, headers=None):
            return yahoo(symbol="ETH-USD") if "finance.yahoo" in url else fake_fetch(url)
        with self.assertRaises(engine.ResearchFailure) as raised:
            engine.build_report(request(), fetch)
        self.assertEqual(raised.exception.code, "IDENTITY_MISMATCH")

    def test_supplied_coin_id_must_match_requested_ticker(self):
        def fetch(url, headers=None):
            return coin(symbol="eth", coin_id="ethereum") if "/coins/" in url else fake_fetch(url)
        with self.assertRaises(engine.ResearchFailure) as raised:
            engine.build_report(request(coinId="ethereum"), fetch)
        self.assertEqual(raised.exception.code, "IDENTITY_MISMATCH")

    def test_partial_provider_failure_is_visible_and_does_not_invent_metrics(self):
        def fetch(url, headers=None):
            if "coingecko" in url:
                raise engine.ResearchFailure("DATA_UNAVAILABLE")
            return yahoo()
        report = engine.build_report(request(), fetch)
        self.assertTrue(any(c["status"] == "missing" and "Token" in c["topic"] for c in report["coverage"]))
        self.assertNotIn("Market capitalisation (USD)", [m["label"] for m in report["metrics"]])

    def test_crypto_can_use_token_evidence_when_daily_prices_are_down(self):
        def fetch(url, headers=None):
            if "finance.yahoo" in url:
                raise engine.ResearchFailure("DATA_UNAVAILABLE")
            return fake_fetch(url)
        report = engine.build_report(request(), fetch)
        self.assertEqual(report["instrument"]["exchange"], "CoinGecko aggregate")
        self.assertEqual(report["sources"][0]["id"], "tokenomics")

    def test_stale_prices_do_not_become_current_stock_research(self):
        with self.assertRaises(engine.ResearchFailure) as raised:
            engine.build_report(request(asset="stock", symbol="AAPL"), lambda *args: yahoo(symbol="AAPL", instrument_type="EQUITY", stale=True))
        self.assertEqual(raised.exception.code, "DATA_UNAVAILABLE")

    def test_no_provider_data_fails_instead_of_publishing_empty_research(self):
        def fetch(*args):
            raise engine.ResearchFailure("DATA_UNAVAILABLE")
        with self.assertRaises(engine.ResearchFailure):
            engine.build_report(request(), fetch)

    def test_deep_engine_failure_does_not_silently_downgrade_to_snapshot(self):
        def agents(report):
            raise engine.ResearchFailure("ENGINE_NOT_INSTALLED")
        with self.assertRaises(engine.ResearchFailure) as raised:
            engine.build_report(request(mode="tradingagents"), fake_fetch, agents)
        self.assertEqual(raised.exception.code, "ENGINE_NOT_INSTALLED")

    def test_historical_and_arbitrary_url_requests_are_rejected(self):
        for extra in ({"date": "2020-01-01"}, {"url": "http://localhost"}):
            with self.assertRaises(engine.ResearchFailure):
                engine.validate_request(request(**extra))

    def test_rsi_treats_flat_series_as_neutral(self):
        self.assertEqual(engine.rsi([100] * 30), 50)
        self.assertEqual(engine.rsi(list(range(1, 31))), 100)
        self.assertEqual(engine.rsi(list(range(31, 1, -1))), 0)
        self.assertIsNone(engine.rsi([100] * 10))

    def test_infinite_or_missing_values_are_not_zero(self):
        for value in (None, float("nan"), float("inf"), "unavailable", True):
            self.assertIsNone(engine.number(value))

    def test_display_rounding_keeps_raw_values_and_does_not_zero_tiny_prices(self):
        report = {"metrics": []}
        engine.add_metric(report, "Price (USD)", "0.00000000000000000000000001", "market")
        engine.add_metric(report, "RSI", "47.0271961853158", "market")
        self.assertNotEqual(report["metrics"][0]["value"], "0.00")
        self.assertEqual(report["metrics"][0]["rawValue"], "0.00000000000000000000000001")
        self.assertEqual(report["metrics"][1]["value"], "47.03")


if __name__ == "__main__":
    unittest.main()
