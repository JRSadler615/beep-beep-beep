import { Link, useLocation, useNavigate } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"

/**
 * Navigation — the top nav bar for the authenticated app shell.
 *
 * Inputs:  none directly; pulls the current user and signOut from AuthContext
 *          and the active path from react-router.
 * Outputs: a <nav> with the brand link, the section links (highlighting the
 *          active route), the signed-in email, and a Sign Out button that signs
 *          out of Supabase and redirects home.
 */
export default function Navigation() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user, signOut } = useAuth()

  const navItems = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/ebay-connect", label: "Connect eBay" },
    { href: "/product-search", label: "Product Search" },
    { href: "/settings", label: "Settings" },
  ]

  const handleSignOut = async () => {
    await signOut()
    navigate("/")
  }

  return (
    <nav className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex">
            <div className="flex-shrink-0 flex items-center">
              <Link
                to="/dashboard"
                className="text-2xl font-bold text-blue-600 dark:text-blue-400"
              >
                Beep Beep
              </Link>
            </div>
            <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${
                    pathname === item.href
                      ? "border-blue-500 text-gray-900 dark:text-white"
                      : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center">
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {user?.email}
              </span>
              <button
                onClick={handleSignOut}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors duration-200"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
