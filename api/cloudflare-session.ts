export default async function handler(
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return res.status(500).json({
      ok: false,
      error: 'Missing Cloudflare environment variables',
    });
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=600000&targets=true&liveViewUrlExpiresInMs=600000`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    const data = (await response.json()) as {
      sessionId?: string;
      webSocketDebuggerUrl?: string;
      targets?: Array<{
        id?: string;
        type?: string;
        title?: string;
        url?: string;
        devtoolsFrontendUrl?: string;
        webSocketDebuggerUrl?: string;
      }>;
      result?: {
        sessionId?: string;
        webSocketDebuggerUrl?: string;
        targets?: Array<{
          id?: string;
          type?: string;
          title?: string;
          url?: string;
          devtoolsFrontendUrl?: string;
          webSocketDebuggerUrl?: string;
        }>;
      };
    };

    const payload = data.result ?? data;
    const sessionId = payload.sessionId;
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const target = targets.find((item) => item.type === 'page') ?? targets[0] ?? null;
    const liveViewUrl = target?.devtoolsFrontendUrl ?? null;

    if (!response.ok || !sessionId || !liveViewUrl) {
      return res.status(response.status || 500).json({
        ok: false,
        cloudflareStatus: response.status,
        sessionId: sessionId ?? null,
        targetCount: targets.length,
        response: data,
      });
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      keepAliveMs: 600000,
      target: {
        id: target?.id ?? null,
        title: target?.title ?? null,
        url: target?.url ?? null,
      },
      liveViewUrl,
      instructions:
        'Open liveViewUrl immediately. The session starts on about:blank; navigate manually to facebook.com, log in, then open Marketplace.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
