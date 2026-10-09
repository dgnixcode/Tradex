"""Subprocess-boundary fixture, never used by the research worker."""
import json
import os
import sys
import time

request = json.load(sys.stdin)
if request["symbol"] == "WAIT-USD":
    time.sleep(10)
elif request["symbol"] == "EXIT-USD":
    print(json.dumps({"errorCode": "LLM_NOT_CONFIGURED"}))
    sys.exit(1)
elif request["symbol"] == "LARGE-USD":
    print("x" * 2_000_001)
elif request["symbol"] == "LEAK-USD":
    print(json.dumps({"content": os.environ.get("OPENAI_API_KEY")}))
else:
    print(json.dumps({"hasDatabase": "DATABASE_URL" in os.environ, "hasExchangeKey": "TRADEX_PEPPER" in os.environ,
                      "hasProviderKey": "OPENAI_API_KEY" in os.environ}))
