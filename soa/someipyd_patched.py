"""Starts the someipy daemon with a fix for someipy 2.1.2.

`someipy.service.Method` defines `__eq__` (on id and protocol) inside a dataclass, which makes
it unhashable. The daemon hashes offered services, including their methods, when a *remote*
node subscribes to an eventgroup, so a service with both methods and events crashes there
(`TypeError: unhashable type: 'Method'`). Give Method a hash consistent with its `__eq__`.

    python someipyd_patched.py --config someipyd.json
"""

from someipy import service
from someipy.someipyd import main

service.Method.__hash__ = lambda self: hash((self.id, self.protocol))

if __name__ == "__main__":
    main()
