interface PortPendingProps {
  title: string
  /** Original Next.js source file this page is being ported from. */
  source: string
  lines: number
}

/**
 * Placeholder for pages not yet ported from the Next.js app. Keeps routing
 * and the app shell working so the SPA runs end-to-end while the large pages
 * are migrated one at a time. Delete each instance as its page lands.
 */
export default function PortPending({ title, source, lines }: PortPendingProps) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
        {title}
      </h1>
      <p className="text-gray-600 dark:text-gray-300 mb-2">
        This page is pending migration from the Next.js app.
      </p>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Port from <code className="font-mono">{source}</code> ({lines} lines).
        See <code className="font-mono">frontend/README.md</code> for the
        transform rules.
      </p>
    </div>
  )
}
