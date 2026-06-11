import { prisma } from "./prisma"

// Reads an error response body exactly once. A fetch Response body is a
// one-shot stream, so we read it as text (always safe) and then attempt to
// parse JSON from it. When eBay returns a non-JSON body (gateway HTML,
// plain-text proxy errors), errorData is {} but errorText preserves the raw
// body for logging.
export async function readErrorBody(
  response: Response
): Promise<{ errorData: any; errorText: string }> {
  const errorText = await response.text().catch(() => "")
  try {
    return { errorData: JSON.parse(errorText), errorText }
  } catch {
    return { errorData: {}, errorText }
  }
}

export const isSandbox = () => process.env.EBAY_SANDBOX === "true"

export const getEbayBaseUrl = () =>
  isSandbox() ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"

export const getEbayTokenEndpoint = () =>
  `${getEbayBaseUrl()}/identity/v1/oauth2/token`

// Standard headers for eBay Sell API calls.
export const ebayHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "Content-Language": "en-US",
  "Accept-Language": "en-US",
  "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
})

// Verbose diagnostic logging, disabled unless EBAY_DEBUG=true.
// Never log access tokens, even in debug mode.
const DEBUG = process.env.EBAY_DEBUG === "true"
export function debugLog(...args: unknown[]) {
  if (DEBUG) console.log(...args)
}

export type EbayTokenResult =
  | { ok: true; accessToken: string }
  | {
      ok: false
      status: number
      error: string
      needsReconnect?: boolean
      details?: any
    }

// Returns a valid access token for the user, refreshing (and persisting the
// refreshed token) if the stored one is expired. All eBay routes share this
// instead of re-implementing the refresh flow.
export async function getValidEbayToken(
  userId: string
): Promise<EbayTokenResult> {
  const ebayToken = await prisma.ebayToken.findUnique({ where: { userId } })

  if (!ebayToken) {
    return {
      ok: false,
      status: 400,
      error:
        "eBay account not connected. Please connect your eBay account first.",
    }
  }

  if (new Date() < ebayToken.expiresAt) {
    return { ok: true, accessToken: ebayToken.accessToken }
  }

  if (!ebayToken.refreshToken) {
    return {
      ok: false,
      status: 401,
      error: "eBay token expired. Please reconnect your eBay account.",
      needsReconnect: true,
    }
  }

  const refreshResponse = await fetch(getEbayTokenEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: ebayToken.refreshToken,
    }),
  })

  if (!refreshResponse.ok) {
    const { errorData } = await readErrorBody(refreshResponse)
    console.error("eBay token refresh failed:", refreshResponse.status, errorData)

    // 400/401 means the refresh token itself is invalid/expired - delete it
    // so the user is forced to reconnect. Other statuses (network/5xx) keep
    // the token so a transient failure doesn't log the user out of eBay.
    if (refreshResponse.status === 400 || refreshResponse.status === 401) {
      try {
        await prisma.ebayToken.delete({ where: { userId } })
      } catch (deleteError) {
        console.error("Failed to delete token after refresh failure:", deleteError)
      }
      return {
        ok: false,
        status: 401,
        error:
          "Failed to refresh eBay token. Please reconnect your eBay account.",
        needsReconnect: true,
        details: errorData,
      }
    }

    return {
      ok: false,
      status: refreshResponse.status,
      error: "Failed to refresh eBay token. Please try again.",
      details: errorData,
    }
  }

  const refreshData = await refreshResponse.json()

  await prisma.ebayToken.update({
    where: { userId },
    data: {
      accessToken: refreshData.access_token,
      refreshToken: refreshData.refresh_token || ebayToken.refreshToken,
      expiresAt: new Date(Date.now() + refreshData.expires_in * 1000),
    },
  })

  return { ok: true, accessToken: refreshData.access_token }
}
