import { Routes, Route } from "react-router-dom"
import Home from "@/pages/Home"
import Login from "@/pages/Login"
import Signup from "@/pages/Signup"
import Dashboard from "@/pages/Dashboard"
import EbayConnect from "@/pages/EbayConnect"
import ProductSearch from "@/pages/ProductSearch"
import Settings from "@/pages/Settings"
import ProtectedRoute from "@/components/ProtectedRoute"

export default function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />

      {/* Authenticated app shell (Navigation + Supabase session gate) */}
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/ebay-connect" element={<EbayConnect />} />
        <Route path="/product-search" element={<ProductSearch />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
