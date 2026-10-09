import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("tradex_probe_engine", Path(__file__).parents[1] / "engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class ModelErrorTests(unittest.TestCase):
    def test_structured_errors_are_classified_without_exposing_messages(self):
        for status, code in [(401, "AUTH_FAILED"), (403, "MODEL_UNAVAILABLE"), (404, "MODEL_UNAVAILABLE"),
                             (402, "QUOTA_EXCEEDED"), (429, "RATE_LIMITED"), (400, "UNSUPPORTED_MODEL"),
                             (500, "CONNECTION_FAILED"), (504, "TIMEOUT")]:
            error = Exception("synthetic-secret-provider-message")
            error.status_code = status
            self.assertEqual(engine.model_test_error(error), code)
        error = Exception("private")
        error.status_code = 429
        error.body = {"error": {"code": "insufficient_quota", "message": "private-key"}}
        self.assertEqual(engine.model_test_error(error), "QUOTA_EXCEEDED")
        error.status_code = 400
        error.body = {"error": {"details": [{"reason": "API_KEY_INVALID"}]}}
        self.assertEqual(engine.model_test_error(error), "AUTH_FAILED")
        self.assertEqual(engine.model_test_error(TimeoutError("private")), "TIMEOUT")
        self.assertEqual(engine.model_test_error(ConnectionError("private")), "CONNECTION_FAILED")
        self.assertEqual(engine.model_test_error(Exception("private")), "TEST_FAILED")
        original = Exception("private-provider-body")
        original.code = 400
        original.details = {"error": {"details": [{"reason": "API_KEY_INVALID"}]}}
        wrapped = Exception("private-langchain-message")
        wrapped.__cause__ = original
        self.assertEqual(engine.model_test_error(wrapped), "AUTH_FAILED")


try:
    import tradingagents.llm_clients.factory
    INSTALLED = True
except ImportError:
    INSTALLED = False


@unittest.skipUnless(INSTALLED, "requires pinned TradingAgents environment")
class ModelProbeTests(unittest.TestCase):
    def test_real_upstream_clients_send_token_caps_tools_and_no_retries(self):
        import httpx
        import httpx2
        from google.genai.errors import ClientError
        from tradingagents.llm_clients.factory import create_llm_client as real_factory
        for provider in ("openai", "anthropic", "google"):
            requests = []
            transport_module = httpx2 if provider == "anthropic" else httpx

            def transport(request):
                requests.append((request.url.path, json.loads(request.content)))
                return transport_module.Response(401, json={"type": "error", "error": {"type": "authentication_error",
                    "code": "invalid_api_key", "message": "synthetic-private-message"}})

            def google_call(*args, **kwargs):
                requests.append(kwargs)
                raise ClientError(400, {"error": {"details": [{"reason": "API_KEY_INVALID"}], "message": "private"}})

            with transport_module.Client(transport=transport_module.MockTransport(transport)) as client:
                def factory(**kwargs):
                    if provider == "openai":
                        kwargs["http_client"] = client
                    return real_factory(**kwargs)

                env = {"TRADEX_RESEARCH_LLM_PROVIDER": provider, "TRADEX_RESEARCH_DEEP_MODEL": "test-shared",
                       "TRADEX_RESEARCH_QUICK_MODEL": "test-shared", "OPENAI_API_KEY": "synthetic-openai-key",
                       "ANTHROPIC_API_KEY": "synthetic-anthropic-key", "GOOGLE_API_KEY": "synthetic-google-key"}
                with patch.dict(os.environ, env), patch.object(engine, "check_configuration"), \
                        patch("tradingagents.llm_clients.factory.create_llm_client", factory), \
                        patch("langchain_anthropic.chat_models._get_default_httpx_client", return_value=client), \
                        patch("google.genai.models.Models.generate_content", google_call):
                    result = engine.test_models()
            self.assertEqual(result, {"deep": "AUTH_FAILED", "quick": "AUTH_FAILED"}, provider)
            self.assertEqual(len(requests), 1, provider)
            if provider == "google":
                config = requests[0]["config"]
                self.assertEqual(config.max_output_tokens, 256)
                self.assertEqual(config.http_options.timeout, 15000)
                self.assertEqual(config.http_options.retry_options.attempts, 0)
                self.assertTrue(config.tools)
            else:
                path, payload = requests[0]
                self.assertTrue(path.endswith("responses" if provider == "openai" else "messages"))
                self.assertEqual(payload["max_output_tokens" if provider == "openai" else "max_tokens"], 256)
                self.assertTrue(payload["tools"])

    def probe(self, provider="openai", deep="test-deep", quick="test-quick", fail=None, empty=False):
        calls = []

        class Llm:
            def __init__(self, model):
                self.model = model

            def get_llm(self):
                return self

            def bind_tools(self, tools):
                calls[-1]["tools"] = tools
                return self

            def invoke(self, messages):
                calls[-1]["prompt"] = messages[0].content
                if fail and self.model == deep:
                    raise fail
                return SimpleNamespace(content="" if empty else "OK", tool_calls=[], response_metadata={})

        def factory(**kwargs):
            calls.append(kwargs)
            return Llm(kwargs["model"])

        env = {"TRADEX_RESEARCH_LLM_PROVIDER": provider, "TRADEX_RESEARCH_DEEP_MODEL": deep,
               "TRADEX_RESEARCH_QUICK_MODEL": quick}
        with patch.dict(os.environ, env), patch.object(engine, "check_configuration"), \
                patch("tradingagents.llm_clients.factory.create_llm_client", factory):
            result = engine.test_models()
        return result, calls

    def test_both_roles_use_upstream_factory_and_bounded_non_retrying_requests(self):
        for provider in ("openai", "anthropic", "google"):
            result, calls = self.probe(provider)
            self.assertEqual(result, {"deep": "OK", "quick": "OK"})
            self.assertEqual(len(calls), 2)
            for call in calls:
                self.assertEqual(call["provider"], provider)
                self.assertEqual(call["max_retries"], 0)
                self.assertEqual(call["timeout"], 15)
                self.assertEqual(call["max_output_tokens" if provider == "google" else "max_tokens"], 256)
                self.assertEqual(len(call["tools"]), 1)
                self.assertLess(len(call["prompt"]), 100)

    def test_shared_model_is_called_once_and_failures_do_not_skip_other_role(self):
        result, calls = self.probe(quick="test-deep")
        self.assertEqual(result, {"deep": "OK", "quick": "OK"})
        self.assertEqual(len(calls), 1)
        result, calls = self.probe(fail=TimeoutError("private-key"))
        self.assertEqual(result, {"deep": "TIMEOUT", "quick": "OK"})
        self.assertEqual(len(calls), 2)
        self.assertNotIn("private-key", json.dumps(result))

    def test_empty_completion_is_inconclusive_and_invalid_models_never_call_provider(self):
        result, _ = self.probe(empty=True)
        self.assertEqual(result, {"deep": "TOKEN_LIMIT", "quick": "TOKEN_LIMIT"})
        result, calls = self.probe(deep="https://unsafe?secret")
        self.assertEqual(result, {"deep": "TEST_FAILED", "quick": "TEST_FAILED"})
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
