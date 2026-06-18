import { Navigate, Outlet } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"
import Navigation from "./Navigation"

/**
 * Gates the authenticated app shell. Replaces the Next.js middleware +
 * server-side session redirect. Renders Navigation + the matched child route.
 */
export default function ProtectedRoute() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500">Loading…</p>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Navigation />
      <main>
        <Outlet />
      </main>
    </div>
  )
}
