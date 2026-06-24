import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "./index.css"
import App from "./App"
import { AuthProvider } from "@/context/AuthContext"

/**
 * SPA entry point. Mounts <App> into #root, wrapped in the providers every page
 * relies on: BrowserRouter (URL routing) and AuthProvider (Supabase session).
 * StrictMode is on for dev-time checks. No inputs/outputs — side-effecting boot.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
)
