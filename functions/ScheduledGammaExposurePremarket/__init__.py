import logging
import os
import sys
from datetime import datetime

import azure.functions as func

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ScheduledGammaExposure import run_gex


def main(mytimer: func.TimerRequest) -> None:
    if mytimer.past_due:
        logging.warning('ScheduledGammaExposurePremarket timer trigger is past due!')
    logging.info(f'ScheduledGammaExposurePremarket started at {datetime.utcnow()}')
    run_gex(premarket=True)
