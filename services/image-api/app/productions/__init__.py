"""Productions: plan series -> episodes -> scenes -> shots and render the takes overnight.

State lives in Mongo (see store.py); image-api's in-memory queue stays the
executor and is fed one take at a time by the dispatcher (dispatcher.py).
"""
