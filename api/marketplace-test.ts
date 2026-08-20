const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/giza/search?maxPrice=1000000&itemCondition=new&query=toyota%20corolla%202022&exact=false';

type StorageState = {
  cookies?: Array<{
    name?: string;
    domain?: string;
  }>;
};

function inspectStorageState(value: string) {
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const state = JSON.parse(decoded) as StorageState;
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const facebookCookies = cookies.filter((cookie) =>
    typeof cookie.domain === 'string' && cookie.domain.includes('facebook.com'),
  );

  return {
    validJson: true,
    totalCookies: cookies.length,
    facebookCookieCount: facebookCookies.length,
    facebookCookieNames: facebookCookies
      .map((cookie) => cookie.name)
      .filter((name): name is string => Boolean(name)),
  };
}

export default async function handler(
  _req: unknown,
  res: {
    status: (code: number) => {
      json: (body: unknown) => void;
    };
  }
) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const storageStateB64 = process.env.FB_STORAGE_STATE_B64;

  const diagnostics = {
    hasAccountId: Boolean(accountId),
    hasApiToken: Boolean(apiToken),
    hasStorageState: Boolean(storageStateB64),
    accountIdLength: accountId?.length ?? 0,
    apiTokenLength: apiToken?.length ?? 0,
    storageStateLength: storageStateB64?.length ?? 0,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };

  if (!accountId || !apiToken || !storageStateB64) {
    return res.status(500).json({
      ok: false,
      error: 'Missing required environment variables',
      diagnostics,
    });
  }

  let storageState;
  try {
    storageState = inspectStorageState(storageStateB64);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'FB_STORAGE_STATE_B64 is not a valid Playwright storage state',
      diagnostics,
      storageStateError: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: MARKETPLACE_URL,
          gotoOptions: { waitUntil: 'networkidle2' },
        }),
      },
    );

    const data = await response.json();
    const result = (data as { result?: unknown }).result;
    const pageText = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    const textLower = pageText.toLowerCase();
    const loginWallDetected =
      textLower.includes('log into facebook') ||
      textLower.includes('create new account') ||
      textLower.includes('email or mobile number');

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      diagnostics,
      storageState,
      cloudflareStatus: response.status,
      loginWallDetected,
      pageTextPreview: pageText.slice(0, 800),
      rawSuccess: (data as { success?: boolean }).success ?? null,
      errors: (data as { errors?: unknown }).errors ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      diagnostics,
      storageState,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
