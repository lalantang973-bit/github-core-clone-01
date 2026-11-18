// Entry point: bind an ephemeral port, register it with the trial environment,
// serve until the environment reports done, then exit 0.
//
// The environment drives the lifecycle:
//   POST {"port": N}  -> $MAKEFUN_ENV_URL/register
//   GET               -> $MAKEFUN_ENV_URL/done   (long-poll until {"done": true})
// Without $MAKEFUN_ENV_URL (local runs) the forge just listens and logs.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? '0') || 0;

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} returned HTTP ${response.status}`);
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    const response = await fetch(`${envUrl.replace(/\/+$/, '')}/done`);
    if (response.ok) {
      const body = (await response.json()) as { done?: boolean };
      if (body.done === true) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const app = createApp({ token: TOKEN });
  const port = await new Promise<number>((resolve, reject) => {
    app.once('error', reject);
    app.listen(PORT, '127.0.0.1', () => {
      const address = app.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`forge listening on 127.0.0.1:${port}`);

  if (!ENV_URL) {
    console.log('MAKEFUN_ENV_URL is not set; serving without trial registration');
    return;
  }
  await postJson(`${ENV_URL.replace(/\/+$/, '')}/register`, { port });
  console.log(`registered port ${port} with ${ENV_URL}`);
  await waitForDone(ENV_URL);
  console.log('trial done; exiting 0');
  app.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
