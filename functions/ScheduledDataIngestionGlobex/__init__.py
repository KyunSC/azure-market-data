import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ScheduledDataIngestion import main as _ingest_main


def main(mytimer):
    _ingest_main(mytimer)
