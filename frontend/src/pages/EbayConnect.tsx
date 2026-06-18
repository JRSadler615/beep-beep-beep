import { useState, useEffect } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { apiFetch } from "@/lib/api"

const connectErrorMessage = "Could not start the eBay connection. Please try again."

const errorMessages: Record<string, string> = {
  missing_credentials:
    "eBay API credentials not configured. Please add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to the backend environment.",
  missing_runame:
    "eBay RuName (Redirect URL name) not configured. Please register your callback URL in eBay Developer Portal and add EBAY_RUNAME to the backend environment.",
  missing_scopes:
    "Required eBay scopes are missing. Please ensure EBAY_SCOPE includes 'sell.inventory' (required for listing products).",
  misconfigured:
    "eBay OAuth configuration is incomplete. Please check the backend eBay credentials.",
  oauth_failed: "Failed to initiate OAuth flow. Please try again.",
  oauth_declined: "You declined the eBay authorization.",
  unauthorized: "Unauthorized request. Please try again.",
  no_code: "No authorization code received from eBay.",
  token_exchange_failed:
    "Failed to exchange authorization code for access token.",
  redirect_uri_mismatch:
    "Redirect URI mismatch. The RuName in the backend environment must match exactly what's registered in eBay Developer Portal.",
  callback_failed: "OAuth callback failed. Please try again.",
}

export default function EbayConnect() {
  const [searchParams] = useSearchParams()
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    apiFetch<{ connected: boolean }>("/api/ebay/check-connection")
      .then((data) => setIsConnected(data.connected))
      .catch(() => {
        // Connection check failed
      })

    // Handle OAuth callback success/error (backend redirects here with params)
    const success = searchParams.get("success")
    const errorParam = searchParams.get("error")

    if (success === "true") {
      setMessage("✓ Successfully connected to eBay!")
      setIsConnected(true)
    } else if (errorParam) {
      setError(errorMessages[errorParam] || "An unknown error occurred")
    }
  }, [searchParams])

  const handleConnect = async () => {
    setConnecting(true)
    setError("")
    try {
      // Fetch the eBay authorize URL from the backend (this call carries the
      // Supabase bearer token), then redirect the browser to eBay. eBay sends
      // the user back to the backend /callback, which redirects here.
      const { url } = await apiFetch<{ url: string }>("/api/ebay/connect-url")
      window.location.href = url
    } catch (err: any) {
      setError(err.message || connectErrorMessage)
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    if (
      !confirm(
        "Are you sure you want to disconnect your eBay account? You'll need to reconnect to search for products."
      )
    ) {
      return
    }

    setDisconnecting(true)
    setError("")
    setMessage("")

    try {
      await apiFetch("/api/ebay/disconnect", { method: "POST" })
      setMessage("✓ eBay account disconnected successfully")
      setIsConnected(false)
    } catch (err: any) {
      setError(err.message || "Failed to disconnect eBay account")
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-6 sm:px-6 lg:px-8">
      <div className="px-4 py-6 sm:px-0">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">
          Connect eBay Account
        </h1>

        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            eBay Authentication
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Connect your eBay account to get an access token for searching products.
            This will allow you to use the eBay Browse API to search for products by UPC.
          </p>

          {message && (
            <div className="mb-4 p-4 bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-700 text-green-700 dark:text-green-400 rounded">
              {message}
            </div>
          )}

          {error && (
            <div className="mb-4 p-4 bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-400 rounded">
              {error}
            </div>
          )}

          {isConnected ? (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <div className="flex items-center gap-3">
                  <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <h3 className="font-semibold text-green-800 dark:text-green-400">
                      eBay Account Connected
                    </h3>
                    <p className="text-sm text-green-700 dark:text-green-300">
                      You can now search for products!
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex gap-3 flex-wrap">
                <Link
                  to="/product-search"
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors duration-200"
                >
                  Search Products
                </Link>
                <Link
                  to="/dashboard"
                  className="px-6 py-3 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-white font-semibold rounded-lg transition-colors duration-200"
                >
                  Go to Dashboard
                </Link>
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white font-semibold rounded-lg transition-colors duration-200 cursor-pointer"
                >
                  {disconnecting ? "Disconnecting..." : "Disconnect & Revoke Access"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="w-full sm:w-auto px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold rounded-lg transition-colors duration-200"
              >
                {connecting ? "Redirecting to eBay..." : "Connect eBay Account"}
              </button>
            </div>
          )}
        </div>

        {isConnected && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-blue-800 dark:text-blue-400 mb-2">
              Need to Re-authorize?
            </h3>
            <p className="text-sm text-blue-700 dark:text-blue-300 mb-3">
              If you want to see the permission screen again when reconnecting, you can:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-blue-700 dark:text-blue-300 text-sm">
              <li>Click "Disconnect & Revoke Access" above (this revokes the authorization on eBay's side)</li>
              <li>Or manually revoke access in your eBay account settings:
                <ul className="list-disc list-inside ml-4 mt-1">
                  <li>Go to <a href="https://www.ebay.com/mys/home?source=MYE_LEFTNAV" target="_blank" rel="noopener noreferrer" className="underline">My eBay</a></li>
                  <li>Navigate to Account → Site Preferences → Authorized Applications</li>
                  <li>Find this app and click "Revoke Access"</li>
                </ul>
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}
