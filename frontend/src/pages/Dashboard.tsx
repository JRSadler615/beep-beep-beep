import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"
import { apiFetch } from "@/lib/api"
import ProductSearchCard from "@/components/ProductSearchCard"

export default function Dashboard() {
  const { user } = useAuth()
  const [isConnected, setIsConnected] = useState(false)

  // The Next.js server component queried Prisma directly for the eBay token;
  // in the SPA we ask the backend whether the account is connected.
  useEffect(() => {
    apiFetch<{ connected: boolean }>("/api/ebay/check-connection")
      .then((data) => setIsConnected(data.connected))
      .catch(() => setIsConnected(false))
  }, [])

  const displayName = user?.user_metadata?.name || user?.email

  return (
    <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div className="px-4 py-6 sm:px-0">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">
          Dashboard
        </h1>
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            Welcome back, {displayName}!
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Get started by connecting your eBay account and searching for products.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Link
            to="/ebay-connect"
            className="block bg-white dark:bg-gray-800 shadow rounded-lg p-6 hover:shadow-lg transition-shadow duration-200"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                  Connect eBay Account
                </h3>
                <p className="text-gray-600 dark:text-gray-400">
                  Authenticate with eBay to get your access token
                </p>
              </div>
              <svg
                className="w-8 h-8 text-blue-600 dark:text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
          </Link>

          <ProductSearchCard isConnected={isConnected} />
        </div>
      </div>
    </div>
  )
}
