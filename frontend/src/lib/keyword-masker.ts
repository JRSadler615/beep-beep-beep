import { apiFetch } from "./api"

/**
 * Utility function to mask banned keywords in text
 * Replaces banned keywords with asterisks (*) while preserving case sensitivity
 */
export function maskKeywords(text: string, bannedKeywords: string[]): string {
  if (!text || bannedKeywords.length === 0) {
    return text
  }

  let maskedText = text

  // Sort keywords by length (longest first) to handle overlapping keywords correctly
  const sortedKeywords = [...bannedKeywords].sort((a, b) => b.length - a.length)

  for (const keyword of sortedKeywords) {
    if (!keyword || keyword.trim().length === 0) {
      continue
    }

    const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "gi")
    maskedText = maskedText.replace(regex, (match) => "*".repeat(match.length))
  }

  return maskedText
}

/**
 * Utility function to remove banned keywords from text completely
 */
export function removeKeywords(text: string, bannedKeywords: string[]): string {
  if (!text || bannedKeywords.length === 0) {
    return text
  }

  let processedText = text

  const sortedKeywords = [...bannedKeywords].sort((a, b) => b.length - a.length)

  for (const keyword of sortedKeywords) {
    if (!keyword || keyword.trim().length === 0) {
      continue
    }

    const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "gi")
    processedText = processedText.replace(regex, "")
  }

  // Clean up extra spaces and punctuation artifacts
  processedText = processedText
    .replace(/,\s*,/g, ",")
    .replace(/;\s*;/g, ";")
    .replace(/:\s*:/g, ":")
    .replace(/\s+/g, " ")
    .replace(/\s+([,\.;:!?])/g, "$1")
    .replace(/([\(\[\{])\s+/g, "$1")
    .replace(/\s+([\)\]\}])/g, "$1")
    .replace(/\s+-\s+/g, " - ")
    .replace(/^\s*[,\.;:!?]\s*/g, "")
    .trim()

  return processedText
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Fetch banned keywords for the current user
 */
export async function fetchBannedKeywords(): Promise<string[]> {
  try {
    const data = await apiFetch<{ keywords?: { keyword: string }[] }>(
      "/api/settings/banned-keywords"
    )
    return data.keywords?.map((k) => k.keyword.toLowerCase()) || []
  } catch (error) {
    console.error("[fetchBannedKeywords] Error:", error)
    return []
  }
}
