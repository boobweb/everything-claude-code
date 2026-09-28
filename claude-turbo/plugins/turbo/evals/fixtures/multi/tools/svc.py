import asyncio


class Service:
    """A service."""

    @staticmethod
    def build(cfg):
        return Service()

    async def fetch(self, url, *, retries=3):
        await asyncio.sleep(0)
        return url

    class Inner:
        def ping(self):
            return "pong"


async def run(argv):
    svc = Service.build(None)
    return await svc.fetch(argv[0])
