import { supabase } from "./supabase"

const API_BASE = import.meta.env.VITE_API_URL || ""

/**
 * Thin wrapper around fetch for the FastAPI backend.
 *
 * - Prefixes paths with VITE_API_URL (empty = same-origin /api, proxied to
 *   FastAPI in dev via vite.config.ts).
 * - Attaches the Supabase access token as a Bearer header so FastAPI can
 *   verify the staff session (GoTrue JWT).
 * - Parses JSON and throws an Error with the backend message on non-2xx.
 *
 * This replaces the relative `fetch("/api/...")` calls from the Next.js app.
 * The paths stay the same; only the host and auth header change.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const headers = new Headers(options.headers)
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json")
  }
  if (session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`)
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })

  // Read body once, then attempt JSON parse (mirrors the backend's own
  // readErrorBody helper from the Next.js codebase).
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    const message =
      (body && typeof body === "object" && (body.error || body.detail || body.message)) ||
      `Request failed with status ${res.status}`
    throw new ApiError(message, res.status, body)
  }

  return body as T
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}
