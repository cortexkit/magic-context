"""Apply a SQL script to a throwaway database.

The app read tests cannot call a writer method from their own sources. They
hand the script to this file on standard input and the database path as the
first argument. The script is fixture data, never a live store.
"""

import sqlite3
import sys

path = sys.argv[1]
script = sys.stdin.read()
connection = sqlite3.connect(path)
try:
    connection.executescript(script)
    connection.commit()
finally:
    connection.close()
