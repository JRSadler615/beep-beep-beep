import { Link } from "react-router-dom"

/**
 * Home — the public landing page (unauthenticated).
 *
 * Inputs:  none. Outputs: a marketing hero with Log In / Sign Up call-to-action
 *          links. The app's first screen before a session exists.
 */
export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="max-w-4xl mx-auto px-4 text-center">
        <h1 className="text-5xl md:text-6xl font-bold text-gray-900 dark:text-white mb-6">
          Welcome to Beep Beep
        </h1>
        <p className="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto">
          Search eBay products by UPC code. Connect your eBay account and start
          discovering products instantly.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link
            to="/signup"
            className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-lg transition-colors duration-200 min-w-[150px]"
          >
            Get Started
          </Link>
          <Link
            to="/login"
            className="px-8 py-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-semibold rounded-lg shadow-lg border border-gray-300 dark:border-gray-600 transition-colors duration-200 min-w-[150px]"
          >
            Log In
          </Link>
        </div>
      </div>
    </div>
  )
}
