const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/giza/search?maxPrice=1000000&itemCondition=new&query=toyota%20corolla%202022&exact=false';

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

  const diagnostics = {
    hasAccountId: Boolean(accountId),
    hasApiToken: Boolean(apiToken),
    accountIdLength: accountId?.length ?? 0,
    apiTokenLength: apiToken?.length ?? 0,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };

  if (!accountId || !apiToken) {
    return res.status(500).json({
      ok: false,
      error: 'Missing Cloudflare environment variables',
      diagnostics,
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/links`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: MARKETPLACE_URL,
          gotoOptions: { waitUntil: 'networkidle2' },
          excludeExternalLinks: true,
        }),
      },
    );

    const data = await response.json();
    const links = Array.isArray((data as { result?: unknown }).result)
      ? ((data as { result: string[] }).result ?? [])
      : [];
    const marketplaceItems = links.filter((url) =>
      url.includes('/marketplace/item/'),
    );

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      diagnostics,
      cloudflareStatus: response.status,
      totalLinks: links.length,
      marketplaceItemCount: marketplaceItems.length,
      marketplaceItems: marketplaceItems.slice(0, 20),
      rawSuccess: (data as { success?: boolean }).success ?? null,
      errors: (data as { errors?: unknown }).errors ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      diagnostics,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
