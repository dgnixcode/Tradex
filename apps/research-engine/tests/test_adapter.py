"""Optional adapter tests run in the dedicated installed TradingAgents environment.
They never contact an LLM provider; the graph's output is controlled locally.
"""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("adapter_engine", Path(__file__).parents[1] / "engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
available = importlib.util.find_spec("tradingagents") is not None


@unittest.skipUnless(available, "Install the pinned TradingAgents environment to test the optional adapter")
class AdapterTests(unittest.TestCase):
    def environment(self):
        return patch.dict(os.environ, {"TRADEX_RESEARCH_LLM_PROVIDER": "openai", "OPENAI_API_KEY": "synthetic-unused-key",
            "TRADEX_RESEARCH_DEEP_MODEL": "test-deep", "TRADEX_RESEARCH_QUICK_MODEL": "test-quick"})

    def test_adapter_uses_pinned_package_and_per_run_state_with_crypto_evidence(self):
        captured = []

        class Graph:
            def __init__(self, selected_analysts, debug, config):
                self.config = config
                self.graph = self
                captured.append({"analysts": selected_analysts, "config": config})

            def with_config(self, **kwargs):
                captured[-1]["callbacks"] = kwargs["callbacks"]
                return self

            def resolve_instrument_context(self, ticker, asset_type="stock", trade_date=None):
                return "Exact instrument: " + ticker

            def propagate(self, symbol, date, asset_type):
                captured[-1]["context"] = self.resolve_instrument_context(symbol, asset_type, date)
                return {"market_report": "Technical interpretation", "sentiment_report": "Sentiment findings", "news_report": "Catalysts",
                    "investment_plan": "Investment thesis", "trader_investment_plan": "Trade scenarios", "final_trade_decision": "A tentative thesis.",
                    "investment_debate_state": {"history": "Bull and bear cases."}, "risk_debate_state": {"history": "Risk committee review."}}, "REVIEW"

        report = {"request": {"symbol": "BTC-USD", "assetType": "crypto", "engine": "tradingagents", "horizon": "long_term"},
            "analysisDate": "2026-10-09", "instrument": {"symbol": "BTC-USD", "currency": "USD"},
            "metrics": [{"label": "Circulating supply", "value": "19000000", "sourceId": "tokenomics"}],
            "sources": [{"id": "tokenomics", "provider": "CoinGecko", "url": "https://api.coingecko.com", "asOf": "2026-10-09"}],
            "coverage": [{"topic": "Unlocks", "status": "missing"}], "sections": [], "warnings": []}
        with self.environment(), patch("tradingagents.graph.trading_graph.TradingAgentsGraph", Graph):
            engine.run_tradingagents(report)
            engine.run_tradingagents({**report, "sections": [], "warnings": [], "coverage": []})
        self.assertEqual(captured[0]["analysts"], ["market", "social", "news"])
        self.assertNotEqual(captured[0]["config"]["memory_log_path"], captured[1]["config"]["memory_log_path"])
        self.assertFalse(Path(captured[0]["config"]["memory_log_path"]).parent.exists())
        self.assertEqual(captured[0]["config"]["holding_period_days"], 126)
        self.assertIn("19000000", captured[0]["context"])
        self.assertIn("invalidate the thesis", captured[0]["context"])
        self.assertTrue(all(s["kind"] == "interpretation" for s in report["sections"]))
        self.assertEqual(report["engine"]["version"], engine.UPSTREAM_COMMIT)

    def test_model_call_and_prompt_budgets_fail_before_an_extra_request(self):
        callback = engine.make_budget_callback()
        for _ in range(80):
            callback.on_chat_model_start({}, [[SimpleNamespace(content="small")]])
        with self.assertRaises(engine.ResearchFailure) as raised:
            callback.on_chat_model_start({}, [[SimpleNamespace(content="small")]])
        self.assertEqual(raised.exception.code, "BUDGET_EXCEEDED")
        self.assertEqual(callback.calls, 80)
        other = engine.make_budget_callback()
        with self.assertRaises(engine.ResearchFailure):
            other.on_chat_model_start({}, [[SimpleNamespace(content="x" * 800_001)]])
        self.assertEqual(other.calls, 0)

    def test_provider_usage_is_recorded_without_double_counting(self):
        callback = engine.make_budget_callback()
        message = SimpleNamespace(usage_metadata={"input_tokens": 12, "output_tokens": 3})
        response = SimpleNamespace(generations=[[SimpleNamespace(message=message)]], llm_output={"token_usage": {"prompt_tokens": 12, "completion_tokens": 3}})
        callback.on_llm_end(response)
        self.assertEqual((callback.input_tokens, callback.output_tokens), (12, 3))


if __name__ == "__main__":
    unittest.main()
