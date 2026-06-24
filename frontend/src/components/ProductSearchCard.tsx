import { Link } from "react-router-dom"

interface ProductSearchCardProps {
  /** Whether the user's eBay account is connected — gates the card. */
  isConnected: boolean
}

/**
 * ProductSearchCard — the dashboard tile that links to the product search page.
 *
 * Input:  isConnected — when false the card is dimmed, shows a "Locked" badge,
 *         and the link is disabled (search requires a connected eBay account).
 * Output: a clickable card linking to /product-search (or inert when locked).
 */
export default function ProductSearchCard({ isConnected }: ProductSearchCardProps) {
  return (
    <div className={`block bg-white dark:bg-gray-800 shadow rounded-lg p-6 ${isConnected ? 'hover:shadow-lg cursor-pointer' : 'opacity-60 cursor-not-allowed'} transition-shadow duration-200`}>
      <Link
        to={isConnected ? "/product-search" : "#"}
        className={isConnected ? "" : "pointer-events-none"}
        onClick={(e) => {
          if (!isConnected) {
            e.preventDefault()
          }
        }}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Search Products
              </h3>
              {!isConnected && (
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-yellow-800 bg-yellow-100 dark:bg-yellow-900/30 dark:text-yellow-400 rounded">
                  🔒 Locked
                </span>
              )}
            </div>
            <p className="text-gray-600 dark:text-gray-400">
              {isConnected
                ? "Search eBay products by UPC code"
                : "Connect eBay account first to search products"
              }
            </p>
          </div>
          <svg
            className={`w-8 h-8 ${isConnected ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-600'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
      </Link>
    </div>
  )
}
