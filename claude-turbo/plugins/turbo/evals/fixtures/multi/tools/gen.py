"""Generate question banks."""
import json
import sys

MAX_ITEMS = 40
TAGS = ["neuro", "msk"]


class Generator:
    def __init__(self, n):
        self.n = n

    def make(self):
        return [{"id": i, "q": f"Q{i}", "a": ["A", "B", "C", "D"], "c": i % 4} for i in range(self.n)]


def main(argv):
    g = Generator(int(argv[1]) if len(argv) > 1 else MAX_ITEMS)
    json.dump(g.make(), sys.stdout)


if __name__ == "__main__":
    main(sys.argv)
