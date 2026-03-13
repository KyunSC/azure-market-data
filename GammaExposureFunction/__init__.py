import azure.functions as func
import json
import logging
import sys
import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError

# Add parent directory to path so we can import shared module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.gex_calculator import fetch_prices_and_compute_gex

TIMEOUT_SECONDS = 60


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("GammaExposure request received")

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(fetch_prices_and_compute_gex)
            result = future.result(timeout=TIMEOUT_SECONDS)

        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200
        )

    except TimeoutError:
        logging.error("Timeout computing gamma exposure")
        return func.HttpResponse(
            json.dumps({"error": "Request timed out"}),
            mimetype="application/json",
            status_code=504
        )
    except ValueError as e:
        logging.error(f"Value error computing GEX: {e}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=400
        )
    except Exception as e:
        logging.error(f"Error computing gamma exposure: {e}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )