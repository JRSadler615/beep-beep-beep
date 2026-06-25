import { useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { apiRequest } from "@/lib/api"
import { DEFAULT_SELLER_NOTE } from "@/lib/constants"

interface Policy {
  id: string
  name: string
  description?: string
}

interface EbayPolicies {
  fulfillmentPolicies: Policy[]
  paymentPolicies: Policy[]
  returnPolicies: Policy[]
}

/**
 * Settings — configures everything the listing flow depends on.
 *
 * Each card loads from and saves to its own /api/settings/* endpoint:
 *   SKU prefix/counter, eBay business policies, inventory (ship-from) location,
 *   per-media-type dimension/weight defaults, banned keywords, discount,
 *   default edit mode, universal seller note, universal override description,
 *   and Best Offer settings.
 *
 * Inputs:  the user's saved settings (fetched on mount) and form edits.
 * Outputs: persisted settings via POST upserts; renders a success/error banner
 *          per save. No listing happens here — this only stores configuration.
 */
export default function Settings() {
  const [nextSkuCounter, setNextSkuCounter] = useState<number>(1)
  const [skuPrefix, setSkuPrefix] = useState<string | null>(null)
  const [initialSkuInput, setInitialSkuInput] = useState<string>("")
  const [prefixInput, setPrefixInput] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [savingCounter, setSavingCounter] = useState(false)
  const [savingPrefix, setSavingPrefix] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [showSearch, setShowSearch] = useState(false)

  // eBay Business Policies state
  const [availablePolicies, setAvailablePolicies] = useState<EbayPolicies | null>(null)
  const [loadingPolicies, setLoadingPolicies] = useState(false)
  const [savingPolicies, setSavingPolicies] = useState(false)
  const [selectedPaymentPolicy, setSelectedPaymentPolicy] = useState<string>("")
  const [selectedReturnPolicy, setSelectedReturnPolicy] = useState<string>("")
  const [selectedFulfillmentPolicy, setSelectedFulfillmentPolicy] = useState<string>("")
  const [ebayConnected, setEbayConnected] = useState(false)

  // Banned Keywords state
  const [bannedKeywords, setBannedKeywords] = useState<Array<{ id: string; keyword: string }>>([])
  const [newKeyword, setNewKeyword] = useState<string>("")
  const [loadingKeywords, setLoadingKeywords] = useState(false)
  const [savingKeyword, setSavingKeyword] = useState(false)
  const [deletingKeyword, setDeletingKeyword] = useState<string | null>(null)

  // Discount Settings state
  const [discountAmount, setDiscountAmount] = useState<number>(3.0)
  const [minimumPrice, setMinimumPrice] = useState<number>(4.0)
  const [loadingDiscount, setLoadingDiscount] = useState(false)
  const [savingDiscount, setSavingDiscount] = useState(false)

  // Edit Mode Settings state
  const [defaultEditMode, setDefaultEditMode] = useState<boolean>(false)
  const [loadingEditMode, setLoadingEditMode] = useState(false)
  const [savingEditMode, setSavingEditMode] = useState(false)

  // Override Description Settings state
  const [useOverrideDescription, setUseOverrideDescription] = useState<boolean>(false)
  const [overrideDescription, setOverrideDescription] = useState<string>("")
  const [loadingOverrideDescription, setLoadingOverrideDescription] = useState(false)
  const [savingOverrideDescription, setSavingOverrideDescription] = useState(false)

  // Seller Note Editing Settings state
  const [enableSellerNoteEditing, setEnableSellerNoteEditing] = useState<boolean>(false)
  const [sellerNoteText, setSellerNoteText] = useState<string>(DEFAULT_SELLER_NOTE)
  const [loadingSellerNoteEditing, setLoadingSellerNoteEditing] = useState(false)
  const [savingSellerNoteEditing, setSavingSellerNoteEditing] = useState(false)

  // Offer Settings state
  const [allowOffers, setAllowOffers] = useState<boolean>(false)
  const [minimumOfferAmount, setMinimumOfferAmount] = useState<number>(10.0)
  const [loadingOfferSettings, setLoadingOfferSettings] = useState(false)
  const [savingOfferSettings, setSavingOfferSettings] = useState(false)

  // Inventory Location state (ship-from address used for eBay publishing)
  const [addressLine1, setAddressLine1] = useState<string>("")
  const [addressLine2, setAddressLine2] = useState<string>("")
  const [city, setCity] = useState<string>("")
  const [stateOrProvince, setStateOrProvince] = useState<string>("")
  const [postalCode, setPostalCode] = useState<string>("")
  const [country, setCountry] = useState<string>("US")
  const [loadingLocation, setLoadingLocation] = useState(false)
  const [savingLocation, setSavingLocation] = useState(false)

  // Per-media-type dimension/weight defaults
  const MEDIA_TYPES = ["DVD", "Blu-ray", "4k DVD", "CD", "VHS", "Cassette", "Other"]
  type MediaDefault = {
    height: string
    width: string
    depth: string
    dimensionUnits: string
    weight: string
    weightUnits: string
  }
  const emptyDefault: MediaDefault = {
    height: "",
    width: "",
    depth: "",
    dimensionUnits: "inch",
    weight: "",
    weightUnits: "ounce",
  }
  const [mediaDefaults, setMediaDefaults] = useState<Record<string, MediaDefault>>({})
  const [loadingMediaDefaults, setLoadingMediaDefaults] = useState(false)
  const [savingMediaType, setSavingMediaType] = useState<string | null>(null)

  // ---- Shared load/save helpers -------------------------------------------
  // Every settings card repeated the same GET-then-apply and POST-then-toast
  // boilerplate; these collapse that into one place. `begin`/`end` toggle the
  // card's own loading/saving flag; `apply`/`onOk` do the card-specific work.

  /** GET a settings endpoint and apply the JSON on success; soft-fail on error. */
  const loadSetting = async (
    path: string,
    apply: (data: any) => void,
    opts: { begin?: () => void; end?: () => void; label?: string } = {}
  ): Promise<void> => {
    opts.begin?.()
    try {
      const res = await apiRequest(path)
      if (res.ok) apply(await res.json())
    } catch (error) {
      console.error(`Failed to fetch ${opts.label || path}:`, error)
    } finally {
      opts.end?.()
    }
  }

  // Backend error bodies come in two shapes: validation errors use `detail`
  // (FastAPI), handler errors use `error` (+ optional `details`).
  const detailsError = (data: any, failText: string) =>
    data.details ? `${data.error}: ${data.details}` : data.error || failText
  const detailError = (data: any, failText: string) =>
    data.detail || data.error || failText

  /** POST a settings endpoint and show a success/error toast. */
  const postSetting = async (
    path: string,
    body: unknown,
    opts: {
      successText: string
      failText: string
      begin?: () => void
      end?: () => void
      onOk?: (data: any) => void
      extractError?: (data: any, failText: string) => string
    }
  ): Promise<void> => {
    opts.begin?.()
    setMessage(null)
    try {
      const res = await apiRequest(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        setMessage({ type: "success", text: opts.successText })
        opts.onOk?.(data)
      } else {
        setMessage({
          type: "error",
          text: (opts.extractError || detailsError)(data, opts.failText),
        })
      }
    } catch {
      setMessage({ type: "error", text: opts.failText })
    } finally {
      opts.end?.()
    }
  }

  // Fetch all the independent settings cards on mount (eBay connection +
  // policies is handled separately below because it has bespoke error UI).
  useEffect(() => {
    loadSetting(
      "/api/settings/sku",
      (data) => {
        setNextSkuCounter(data.nextSkuCounter || 1)
        setSkuPrefix(data.skuPrefix)
        setPrefixInput(data.skuPrefix || "")
      },
      { end: () => setLoading(false), label: "SKU settings" }
    )

    loadSetting(
      "/api/settings/banned-keywords",
      (data) => setBannedKeywords(data.keywords || []),
      { begin: () => setLoadingKeywords(true), end: () => setLoadingKeywords(false), label: "banned keywords" }
    )

    loadSetting(
      "/api/settings/discount",
      (data) => {
        setDiscountAmount(data.discountAmount || 3.0)
        setMinimumPrice(data.minimumPrice || 4.0)
      },
      { begin: () => setLoadingDiscount(true), end: () => setLoadingDiscount(false), label: "discount settings" }
    )

    loadSetting(
      "/api/settings/edit-mode",
      (data) => setDefaultEditMode(data.defaultEditMode || false),
      { begin: () => setLoadingEditMode(true), end: () => setLoadingEditMode(false), label: "edit mode settings" }
    )

    loadSetting(
      "/api/settings/override-description",
      (data) => {
        setUseOverrideDescription(data.useOverrideDescription || false)
        setOverrideDescription(data.overrideDescription || "")
      },
      {
        begin: () => setLoadingOverrideDescription(true),
        end: () => setLoadingOverrideDescription(false),
        label: "override description settings",
      }
    )

    loadSetting(
      "/api/settings/seller-note",
      (data) => {
        setEnableSellerNoteEditing(data.enableSellerNoteEditing || false)
        setSellerNoteText(data.sellerNoteText || "")
      },
      {
        begin: () => setLoadingSellerNoteEditing(true),
        end: () => setLoadingSellerNoteEditing(false),
        label: "seller note editing settings",
      }
    )

    loadSetting(
      "/api/settings/offers",
      (data) => {
        setAllowOffers(data.allowOffers || false)
        setMinimumOfferAmount(data.minimumOfferAmount || 10.0)
      },
      { begin: () => setLoadingOfferSettings(true), end: () => setLoadingOfferSettings(false), label: "offer settings" }
    )

    loadSetting(
      "/api/settings/location",
      (data) => {
        if (data.location) {
          setAddressLine1(data.location.addressLine1 || "")
          setAddressLine2(data.location.addressLine2 || "")
          setCity(data.location.city || "")
          setStateOrProvince(data.location.stateOrProvince || "")
          setPostalCode(data.location.postalCode || "")
          setCountry(data.location.country || "US")
        }
      },
      { begin: () => setLoadingLocation(true), end: () => setLoadingLocation(false), label: "inventory location" }
    )

    loadSetting(
      "/api/settings/media-defaults",
      (data) => {
        const map: Record<string, MediaDefault> = {}
        for (const d of data.defaults || []) {
          map[d.mediaType] = {
            height: d.height != null ? String(d.height) : "",
            width: d.width != null ? String(d.width) : "",
            depth: d.depth != null ? String(d.depth) : "",
            dimensionUnits: d.dimensionUnits || "inch",
            weight: d.weight != null ? String(d.weight) : "",
            weightUnits: d.weightUnits || "ounce",
          }
        }
        setMediaDefaults(map)
      },
      { begin: () => setLoadingMediaDefaults(true), end: () => setLoadingMediaDefaults(false), label: "media defaults" }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Check if eBay is connected and fetch saved policies
  useEffect(() => {
    const checkEbayConnection = async () => {
      try {
        const res = await apiRequest("/api/ebay/check-connection")
        if (res.ok) {
          const data = await res.json()
          setEbayConnected(data.connected)
          
          if (data.connected) {
            // Automatically fetch available policies from eBay
            setLoadingPolicies(true)
            try {
              const policiesRes = await apiRequest("/api/ebay/policies")
              if (policiesRes.ok) {
                const policiesData = await policiesRes.json()
                setAvailablePolicies(policiesData)
                
                // Then fetch saved policy preferences
                const savedRes = await apiRequest("/api/settings/ebay-policies")
                if (savedRes.ok) {
                  const savedData = await savedRes.json()
                  setSelectedPaymentPolicy(savedData.paymentPolicyId || "")
                  setSelectedReturnPolicy(savedData.returnPolicyId || "")
                  setSelectedFulfillmentPolicy(savedData.fulfillmentPolicyId || "")
                }
              } else {
                // Handle error response
                const errorData = await policiesRes.json()
                console.error("Error fetching policies:", errorData)
                
                if (errorData.needsReconnect) {
                  setMessage({ 
                    type: "error", 
                    text: `${errorData.error} Please disconnect and reconnect your eBay account to grant the required permissions.`
                  })
                } else {
                  setMessage({ 
                    type: "error", 
                    text: errorData.error || "Failed to fetch eBay policies. Please try again."
                  })
                }
              }
            } catch (error) {
              console.error("Failed to fetch policies:", error)
              setMessage({ 
                type: "error", 
                text: "Failed to load eBay policies. Please refresh the page or try again."
              })
            } finally {
              setLoadingPolicies(false)
            }
          }
        }
      } catch (error) {
        console.error("Failed to check eBay connection:", error)
      }
    }

    checkEbayConnection()
  }, [])

  // Fetch available policies when user clicks to load them
  const fetchAvailablePolicies = async () => {
    setLoadingPolicies(true)
    setMessage(null) // Clear any previous messages

    try {
      const res = await apiRequest("/api/ebay/policies")
      if (res.ok) {
        const data = await res.json()
        setAvailablePolicies(data)
        
        // Check if policies are empty
        const totalPolicies = 
          (data.fulfillmentPolicies?.length || 0) + 
          (data.paymentPolicies?.length || 0) + 
          (data.returnPolicies?.length || 0)
        
        if (totalPolicies === 0) {
          setMessage({ 
            type: "error", 
            text: "No policies found. Please create business policies in your eBay account settings first."
          })
        } else {
          setMessage({ 
            type: "success", 
            text: `✓ Loaded ${totalPolicies} policies from eBay`
          })
        }
      } else {
        const errorData = await res.json()
        console.error("Error fetching policies:", errorData)
        
        if (errorData.needsReconnect) {
          setMessage({ 
            type: "error", 
            text: `${errorData.error} Click below to reconnect.`
          })
        } else {
          setMessage({ 
            type: "error", 
            text: errorData.error || "Failed to fetch policies. Please try again."
          })
        }
      }
    } catch (error) {
      console.error("Failed to fetch policies:", error)
      setMessage({ type: "error", text: "Failed to fetch eBay policies. Please check your connection." })
    } finally {
      setLoadingPolicies(false)
    }
  }

  const handleSaveCounter = async () => {
    if (!initialSkuInput || initialSkuInput.trim() === "") {
      setMessage({ type: "error", text: "Please enter an initial SKU number" })
      return
    }

    const counter = parseInt(initialSkuInput)
    if (isNaN(counter) || counter < 1) {
      setMessage({ type: "error", text: "SKU counter must be a positive integer" })
      return
    }

    await postSetting("/api/settings/sku/counter", { nextSkuCounter: counter }, {
      successText: "✓ SKU configured successfully",
      failText: "Failed to save SKU counter",
      begin: () => setSavingCounter(true),
      end: () => setSavingCounter(false),
      onOk: (data) => {
        setNextSkuCounter(data.nextSkuCounter)
        setInitialSkuInput("")
      },
    })
  }

  const handleSavePrefix = () =>
    postSetting("/api/settings/sku/prefix", { skuPrefix: prefixInput }, {
      successText: "✓ Prefix configured successfully",
      failText: "Failed to save prefix",
      begin: () => setSavingPrefix(true),
      end: () => setSavingPrefix(false),
      onOk: (data) => setSkuPrefix(data.skuPrefix),
    })

  const handleSavePolicies = () => {
    // Resolve the selected policy names to store alongside their ids.
    const paymentPolicy = availablePolicies?.paymentPolicies.find(p => p.id === selectedPaymentPolicy)
    const returnPolicy = availablePolicies?.returnPolicies.find(p => p.id === selectedReturnPolicy)
    const fulfillmentPolicy = availablePolicies?.fulfillmentPolicies.find(p => p.id === selectedFulfillmentPolicy)

    return postSetting(
      "/api/settings/ebay-policies",
      {
        paymentPolicyId: selectedPaymentPolicy || null,
        paymentPolicyName: paymentPolicy?.name || null,
        returnPolicyId: selectedReturnPolicy || null,
        returnPolicyName: returnPolicy?.name || null,
        fulfillmentPolicyId: selectedFulfillmentPolicy || null,
        fulfillmentPolicyName: fulfillmentPolicy?.name || null,
      },
      {
        successText: "✓ eBay policies configured successfully",
        failText: "Failed to save eBay policies",
        begin: () => setSavingPolicies(true),
        end: () => setSavingPolicies(false),
      }
    )
  }

  const handleAddKeyword = async () => {
    if (!newKeyword || newKeyword.trim().length === 0) {
      setMessage({ type: "error", text: "Please enter a keyword" })
      return
    }

    setSavingKeyword(true)
    setMessage(null)

    try {
      const res = await apiRequest("/api/settings/banned-keywords", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keyword: newKeyword.trim() }),
      })

      const data = await res.json()

      if (res.ok) {
        setBannedKeywords([...bannedKeywords, data.keyword])
        setNewKeyword("")
        setMessage({ type: "success", text: "✓ Keyword added successfully" })
      } else {
        setMessage({ type: "error", text: data.error || "Failed to add keyword" })
      }
    } catch (error) {
      setMessage({ type: "error", text: "Failed to add keyword" })
    } finally {
      setSavingKeyword(false)
    }
  }

  const handleDeleteKeyword = async (id: string) => {
    setDeletingKeyword(id)
    setMessage(null)

    try {
      const res = await apiRequest(`/api/settings/banned-keywords?id=${id}`, {
        method: "DELETE",
      })

      const data = await res.json()

      if (res.ok) {
        setBannedKeywords(bannedKeywords.filter(k => k.id !== id))
        setMessage({ type: "success", text: "✓ Keyword removed successfully" })
      } else {
        setMessage({ type: "error", text: data.error || "Failed to remove keyword" })
      }
    } catch (error) {
      setMessage({ type: "error", text: "Failed to remove keyword" })
    } finally {
      setDeletingKeyword(null)
    }
  }

  const handleSaveDiscountSettings = () =>
    postSetting("/api/settings/discount", { discountAmount, minimumPrice }, {
      successText: "✓ Discount settings saved successfully",
      failText: "Failed to save discount settings",
      begin: () => setSavingDiscount(true),
      end: () => setSavingDiscount(false),
    })

  const handleSaveEditModeSettings = () =>
    postSetting("/api/settings/edit-mode", { defaultEditMode }, {
      successText: "✓ Edit mode settings saved successfully",
      failText: "Failed to save edit mode settings",
      begin: () => setSavingEditMode(true),
      end: () => setSavingEditMode(false),
    })

  const handleSaveOverrideDescriptionSettings = () =>
    postSetting(
      "/api/settings/override-description",
      { useOverrideDescription, overrideDescription },
      {
        successText: "✓ Override description settings saved successfully",
        failText: "Failed to save override description settings",
        begin: () => setSavingOverrideDescription(true),
        end: () => setSavingOverrideDescription(false),
      }
    )

  const handleSaveSellerNoteEditingSettings = () =>
    postSetting(
      "/api/settings/seller-note",
      { enableSellerNoteEditing, sellerNoteText },
      {
        successText: "✓ Seller note editing setting saved successfully",
        failText: "Failed to save seller note editing setting",
        begin: () => setSavingSellerNoteEditing(true),
        end: () => setSavingSellerNoteEditing(false),
      }
    )

  const handleSaveOfferSettings = () =>
    postSetting("/api/settings/offers", { allowOffers, minimumOfferAmount }, {
      successText: "✓ Offer settings saved successfully",
      failText: "Failed to save offer settings",
      begin: () => setSavingOfferSettings(true),
      end: () => setSavingOfferSettings(false),
    })

  const handleSaveLocation = async () => {
    if (
      !addressLine1.trim() ||
      !city.trim() ||
      !stateOrProvince.trim() ||
      !postalCode.trim()
    ) {
      setMessage({
        type: "error",
        text: "Address line 1, city, state/province, and postal code are required",
      })
      return
    }

    await postSetting(
      "/api/settings/location",
      { addressLine1, addressLine2, city, stateOrProvince, postalCode, country },
      {
        successText: "✓ Inventory location saved successfully",
        failText: "Failed to save inventory location",
        begin: () => setSavingLocation(true),
        end: () => setSavingLocation(false),
        extractError: detailError,
      }
    )
  }

  const getMediaDefault = (mt: string): MediaDefault => mediaDefaults[mt] || emptyDefault

  const updateMediaDefault = (mt: string, field: keyof MediaDefault, value: string) => {
    setMediaDefaults((prev) => ({
      ...prev,
      [mt]: { ...(prev[mt] || emptyDefault), [field]: value },
    }))
  }

  const handleSaveMediaDefault = (mt: string) => {
    const d = getMediaDefault(mt)
    const numOrNull = (v: string) => {
      const t = v.trim()
      if (!t) return null
      const n = Number(t)
      return Number.isNaN(n) ? null : n
    }

    return postSetting(
      "/api/settings/media-defaults",
      {
        mediaType: mt,
        height: numOrNull(d.height),
        width: numOrNull(d.width),
        depth: numOrNull(d.depth),
        dimensionUnits: d.dimensionUnits,
        weight: numOrNull(d.weight),
        weightUnits: d.weightUnits,
      },
      {
        successText: `✓ ${mt} defaults saved`,
        failText: "Failed to save defaults",
        begin: () => setSavingMediaType(mt),
        end: () => setSavingMediaType(null),
        extractError: detailError,
      }
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-4xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <div className="text-center text-gray-600 dark:text-gray-400">Loading settings...</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Beep Beep Settings
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Configure your eBay business policies and listing settings before creating listings.
          </p>

          {/* Search Section */}
          <div className="mb-6">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {showSearch ? "Hide Search" : "Search SKU Settings"}
            </button>

            {showSearch && (
              <div className="mt-4 p-4 bg-white dark:bg-gray-800 rounded-lg shadow">
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by counter or prefix (e.g., '689', 'ASS', 'SKU-1')"
                    className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <button
                    onClick={() => {
                      // Search logic - filter current settings
                      const query = searchQuery.toLowerCase()
                      const matchesCounter = nextSkuCounter.toString().includes(query)
                      const matchesPrefix = (skuPrefix || "Auto-detection").toLowerCase().includes(query)
                      const matchesSku = `${skuPrefix || "SKU"}-${nextSkuCounter}`.toLowerCase().includes(query)
                      
                      if (matchesCounter || matchesPrefix || matchesSku) {
                        setMessage({ type: "success", text: `✓ Found: Counter ${nextSkuCounter}, Prefix: ${skuPrefix || "Auto-detection"}` })
                      } else {
                        setMessage({ type: "error", text: "No matching SKU settings found" })
                      }
                    }}
                    className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Search
                  </button>
                  <button
                    onClick={() => {
                      setSearchQuery("")
                      setMessage(null)
                    }}
                    className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                  >
                    Clear
                  </button>
                </div>
                {searchQuery && (
                  <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded text-sm text-gray-600 dark:text-gray-400">
                    <p>Current Prefix: <strong className="text-gray-900 dark:text-white">{skuPrefix || "SKU (default)"}</strong></p>
                    <p className="mt-1">Current Counter: <strong className="text-gray-900 dark:text-white">{nextSkuCounter}</strong></p>
                    <p className="mt-1">Next SKU will be: <strong className="text-blue-600 dark:text-blue-400 text-lg font-mono">{skuPrefix || "SKU"}-0000{nextSkuCounter}</strong></p>
                    <p className="mt-1 text-xs text-gray-500">Format: <span className="font-mono">{`{Prefix}-0000{Counter}`}</span> (0000 prepended)</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Success/Error Message */}
          {message && (
            <div
              className={`mb-6 p-4 rounded-lg ${
                message.type === "success"
                  ? "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300"
                  : "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300"
              }`}
            >
              <p>{message.text}</p>
              {message.type === "error" && message.text.includes("reconnect") && (
                <div className="mt-3 flex gap-3">
                  <a
                    href="/api/ebay/disconnect"
                    className="inline-block px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors text-sm"
                  >
                    Disconnect eBay
                  </a>
                  <Link
                    to="/ebay-connect"
                    className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-sm"
                  >
                    Reconnect with New Permissions
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* SKU Configuration Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">
              SKU Configuration
            </h2>

            {/* Initial SKU Number Section */}
            <div className="mb-8">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">
                Initial SKU Number
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Set the initial SKU number for your listings. This will be used as the starting point and incremented for each new listing.
              </p>
              
              <div className="inline-block px-4 py-2 mb-3 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 rounded-md font-medium">
                Next SKU Counter: {nextSkuCounter}
              </div>

              <div className="flex gap-3">
                <input
                  type="number"
                  min="1"
                  value={initialSkuInput}
                  onChange={(e) => setInitialSkuInput(e.target.value)}
                  placeholder="Enter initial SKU"
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  onClick={handleSaveCounter}
                  disabled={savingCounter}
                  className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingCounter ? "Saving..." : "Save SKU"}
                </button>
              </div>
            </div>

            {/* SKU Prefix Override Section */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">
                SKU Prefix Override
              </h3>
              
              <div className="inline-block px-4 py-2 mb-3 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 rounded-md font-medium">
                Current Prefix: {skuPrefix || "SKU (default)"}
              </div>

              <div className="flex gap-3 mb-2">
                <input
                  type="text"
                  value={prefixInput}
                  onChange={(e) => setPrefixInput(e.target.value)}
                  placeholder="e.g., DVD, BLU, CD"
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  onClick={handleSavePrefix}
                  disabled={savingPrefix}
                  className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingPrefix ? "Saving..." : "Save Prefix"}
                </button>
              </div>

              <p className="text-sm text-gray-500 dark:text-gray-400">
                Set your custom SKU prefix (e.g., DVD, PROD, ITEM). All SKUs will use format: <span className="font-mono font-semibold">{`{Prefix}-0000{Counter}`}</span>
              </p>
            </div>
          </div>

          {/* eBay Business Policies Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              eBay Business Policies
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Configure your eBay business policies. These policies define payment, return, and shipping terms for your listings.
            </p>

            {!ebayConnected ? (
              <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <p className="text-yellow-800 dark:text-yellow-300">
                  Please connect your eBay account first to configure business policies.
                </p>
                <Link
                  to="/ebay-connect"
                  className="inline-block mt-3 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  Connect eBay Account
                </Link>
              </div>
            ) : loadingPolicies ? (
              <div className="text-center py-8">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-600 dark:text-gray-400">Loading your eBay policies...</p>
              </div>
            ) : !availablePolicies ? (
              <div className="text-center">
                <button
                  onClick={fetchAvailablePolicies}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  Load eBay Policies
                </button>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                  Click to fetch your available eBay business policies
                </p>
              </div>
            ) : (
                  <div className="space-y-6">
                    {/* Payment Policy */}
                    <div>
                      <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                        Payment Policy:
                      </label>
                      <select
                        value={selectedPaymentPolicy}
                        onChange={(e) => setSelectedPaymentPolicy(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="">Select a Payment Policy</option>
                        {availablePolicies.paymentPolicies.map((policy) => (
                          <option key={policy.id} value={policy.id}>
                            {policy.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Return Policy */}
                    <div>
                      <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                        Return Policy:
                      </label>
                      <select
                        value={selectedReturnPolicy}
                        onChange={(e) => setSelectedReturnPolicy(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="">Select a Return Policy</option>
                        {availablePolicies.returnPolicies.map((policy) => (
                          <option key={policy.id} value={policy.id}>
                            {policy.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Fulfillment Policy */}
                    <div>
                      <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                        Fulfillment Policy:
                      </label>
                      <select
                        value={selectedFulfillmentPolicy}
                        onChange={(e) => setSelectedFulfillmentPolicy(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="">Select a Fulfillment Policy</option>
                        {availablePolicies.fulfillmentPolicies.map((policy) => (
                          <option key={policy.id} value={policy.id}>
                            {policy.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-3 pt-4">
                      <button
                        onClick={handleSavePolicies}
                        disabled={savingPolicies}
                        className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {savingPolicies ? "Saving..." : "Save Settings"}
                      </button>
                      <button
                        onClick={fetchAvailablePolicies}
                        disabled={loadingPolicies}
                        className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loadingPolicies ? "Refreshing..." : "Refresh Policies"}
                      </button>
                      <button
                        onClick={() => setMessage({ type: "success", text: "You can configure policies later" })}
                        className="px-6 py-2 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors duration-200"
                      >
                        Skip for Now
                      </button>
                    </div>
                  </div>
            )}
          </div>

          {/* Inventory Location Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Inventory Location
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              eBay requires a ship-from location to publish listings. Enter your address once and it will be created on eBay automatically and reused for every listing. eBay does not provide your account address through its API, so it must be entered here.
            </p>

            {loadingLocation ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading inventory location...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Address Line 1 */}
                <div>
                  <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                    Address Line 1 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={addressLine1}
                    onChange={(e) => setAddressLine1(e.target.value)}
                    placeholder="123 Main St"
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {/* Address Line 2 */}
                <div>
                  <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                    Address Line 2
                  </label>
                  <input
                    type="text"
                    value={addressLine2}
                    onChange={(e) => setAddressLine2(e.target.value)}
                    placeholder="Apt, suite, unit (optional)"
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {/* City + State */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      City <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="City"
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      State / Province <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={stateOrProvince}
                      onChange={(e) => setStateOrProvince(e.target.value)}
                      placeholder="e.g., CA"
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>

                {/* Postal Code + Country */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      Postal Code <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      placeholder="e.g., 90210"
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      Country
                    </label>
                    <input
                      type="text"
                      value={country}
                      onChange={(e) => setCountry(e.target.value.toUpperCase())}
                      placeholder="US"
                      maxLength={2}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Two-letter country code (e.g., US, CA, GB)
                    </p>
                  </div>
                </div>

                {/* Save Button */}
                <div className="pt-4">
                  <button
                    onClick={handleSaveLocation}
                    disabled={savingLocation}
                    className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingLocation ? "Saving..." : "Save Inventory Location"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Media Type Default Dimensions Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Default Dimensions &amp; Weight by Media Type
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Set standard package height, width, depth, and weight for each media type. These pre-fill the listing form when the catalog has no value for an item.
            </p>

            {loadingMediaDefaults ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading defaults...</p>
              </div>
            ) : (
              <div className="space-y-5">
                {MEDIA_TYPES.map((mt) => {
                  const d = getMediaDefault(mt)
                  return (
                    <div key={mt} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{mt}</h3>
                        <button
                          onClick={() => handleSaveMediaDefault(mt)}
                          disabled={savingMediaType === mt}
                          className="px-4 py-1.5 text-sm bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {savingMediaType === mt ? "Saving..." : "Save"}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {([
                          ["H", "height"],
                          ["W", "width"],
                          ["D", "depth"],
                        ] as [string, keyof MediaDefault][]).map(([label, field]) => (
                          <input
                            key={field}
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            value={d[field]}
                            onChange={(e) => updateMediaDefault(mt, field, e.target.value)}
                            placeholder={label}
                            aria-label={`${mt} ${label}`}
                            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                        ))}
                        <select
                          value={d.dimensionUnits}
                          onChange={(e) => updateMediaDefault(mt, "dimensionUnits", e.target.value)}
                          aria-label={`${mt} dimension units`}
                          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value="inch">inch</option>
                          <option value="centimeter">centimeter</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          value={d.weight}
                          onChange={(e) => updateMediaDefault(mt, "weight", e.target.value)}
                          placeholder="Weight"
                          aria-label={`${mt} weight`}
                          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        />
                        <select
                          value={d.weightUnits}
                          onChange={(e) => updateMediaDefault(mt, "weightUnits", e.target.value)}
                          aria-label={`${mt} weight units`}
                          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value="ounce">ounce</option>
                          <option value="pound">pound</option>
                          <option value="gram">gram</option>
                          <option value="kilogram">kilogram</option>
                        </select>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Keyword Ban Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Keyword Ban
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Add keywords to hide/mask when displaying products. These keywords will be replaced with asterisks (*) in product titles and descriptions.
            </p>

            {/* Add Keyword Form */}
            <div className="mb-6">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleAddKeyword()
                    }
                  }}
                  placeholder="Enter keyword to ban (e.g., DVD, Blu-Ray)"
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  onClick={handleAddKeyword}
                  disabled={savingKeyword || !newKeyword.trim()}
                  className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingKeyword ? "Adding..." : "Add Keyword"}
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Keywords are case-insensitive and will match whole words only
              </p>
            </div>

            {/* Banned Keywords List */}
            {loadingKeywords ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading keywords...</p>
              </div>
            ) : bannedKeywords.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <p>No banned keywords yet. Add keywords above to get started.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Banned Keywords ({bannedKeywords.length})
                </h3>
                <div className="flex flex-wrap gap-2">
                  {bannedKeywords.map((keyword) => (
                    <div
                      key={keyword.id}
                      className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md"
                    >
                      <span className="text-sm font-medium text-red-700 dark:text-red-400">
                        {keyword.keyword}
                      </span>
                      <button
                        onClick={() => handleDeleteKeyword(keyword.id)}
                        disabled={deletingKeyword === keyword.id}
                        className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors disabled:opacity-50"
                        aria-label={`Remove ${keyword.keyword}`}
                      >
                        {deletingKeyword === keyword.id ? (
                          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Discount Settings Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Discount Settings
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Configure discount amount (in USD) and minimum price for product listings. The discount will be subtracted from product prices. If the discounted price falls below the minimum, a warning will be shown suggesting to reject the item.
            </p>

            {loadingDiscount ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading discount settings...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Discount Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                    Discount Amount (USD)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={discountAmount}
                      onChange={(e) => setDiscountAmount(parseFloat(e.target.value) || 0)}
                      className="w-full pl-7 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="3.00"
                    />
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    The fixed dollar amount to subtract from product prices (e.g., $3 discount)
                  </p>
                </div>

                {/* Minimum Price */}
                <div>
                  <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                    Minimum Price Floor (USD)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={minimumPrice}
                      onChange={(e) => setMinimumPrice(parseFloat(e.target.value) || 0)}
                      className="w-full pl-7 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="4.00"
                    />
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    The minimum price floor. If the discounted price falls below this value, a warning will be displayed suggesting to reject the item.
                  </p>
                </div>

                {/* Example Preview */}
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">Example:</p>
                  <p className="text-sm text-blue-700 dark:text-blue-400">
                    Original price: $10.00 → After ${discountAmount.toFixed(2)} discount → <strong>${Math.max(10 - discountAmount, minimumPrice).toFixed(2)}</strong>
                    {10 - discountAmount < minimumPrice && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">(floor applied)</span>
                    )}
                  </p>
                  <p className="text-sm text-blue-700 dark:text-blue-400 mt-1">
                    Original price: $5.00 → After ${discountAmount.toFixed(2)} discount → <strong>${Math.max(5 - discountAmount, minimumPrice).toFixed(2)}</strong>
                    {5 - discountAmount < minimumPrice && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">(floor applied - reject warning)</span>
                    )}
                  </p>
                </div>

                {/* Save Button */}
                <div className="pt-4">
                  <button
                    onClick={handleSaveDiscountSettings}
                    disabled={savingDiscount}
                    className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingDiscount ? "Saving..." : "Save Discount Settings"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Edit Mode Settings Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Default Edit Mode
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              When enabled, the product listing page will open directly in edit mode. When disabled, you'll need to click the "Edit" button to edit listings.
            </p>

            {loadingEditMode ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading edit mode settings...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Toggle Switch */}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">
                      Enable Default Edit Mode
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {defaultEditMode 
                        ? "Listings will open in edit mode automatically" 
                        : "Listings will open in view mode (click Edit to modify)"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDefaultEditMode(!defaultEditMode)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                      defaultEditMode ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"
                    }`}
                    role="switch"
                    aria-checked={defaultEditMode}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        defaultEditMode ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                {/* Save Button */}
                <div className="pt-4">
                  <button
                    onClick={handleSaveEditModeSettings}
                    disabled={savingEditMode}
                    className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingEditMode ? "Saving..." : "Save Edit Mode Settings"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Seller Note Editing Settings Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Universal Seller Note
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Set a universal seller note that will be sent to eBay as <span className="font-mono">conditionDescription</span> for all listings when enabled.
            </p>

            {loadingSellerNoteEditing ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading seller note editing setting...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Toggle Switch */}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">
                      Enable Universal Seller Note
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {enableSellerNoteEditing
                        ? "All listings will use the seller note text below"
                        : "Listings will use the default seller note text"}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enableSellerNoteEditing}
                      onChange={(e) => setEnableSellerNoteEditing(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div
                      className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600`}
                    />
                  </label>
                </div>

                {enableSellerNoteEditing && (
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      Universal Seller Note Text
                    </label>
                    <textarea
                      value={sellerNoteText}
                      onChange={(e) => setSellerNoteText(e.target.value)}
                      placeholder="Enter seller note text for all listings"
                      rows={4}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      This note is applied to every listing as eBay&apos;s conditionDescription.
                    </p>
                  </div>
                )}

                {enableSellerNoteEditing && sellerNoteText && (
                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">Preview:</p>
                    <p className="text-sm text-blue-700 dark:text-blue-400 whitespace-pre-wrap">{sellerNoteText}</p>
                  </div>
                )}

                <div className="pt-4">
                  <button
                    onClick={handleSaveSellerNoteEditingSettings}
                    disabled={savingSellerNoteEditing}
                    className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingSellerNoteEditing ? "Saving..." : "Save Seller Note Editing Setting"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Override Description Settings Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Universal Override Description
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Set a universal description that will automatically apply to ALL product listings. When enabled, this description replaces the default eBay product description for every item you list.
            </p>

            {loadingOverrideDescription ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading override description settings...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Toggle Switch */}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">
                      Enable Universal Override Description
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {useOverrideDescription 
                        ? "All listings will use the override description below" 
                        : "Listings will use the default eBay product description"}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useOverrideDescription}
                      onChange={(e) => setUseOverrideDescription(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                {/* Override Description Text Area - only show when enabled */}
                {useOverrideDescription && (
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      Default Override Description
                    </label>
                    <textarea
                      value={overrideDescription}
                      onChange={(e) => setOverrideDescription(e.target.value)}
                      placeholder="e.g., New in packaging. Ships in 2 days."
                      rows={4}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      This description will be automatically applied to all products when listing on eBay. You can still edit it per-product if needed.
                    </p>
                  </div>
                )}

                {/* Preview */}
                {useOverrideDescription && overrideDescription && (
                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <p className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">Preview:</p>
                    <p className="text-sm text-blue-700 dark:text-blue-400 whitespace-pre-wrap">{overrideDescription}</p>
                  </div>
                )}

                {/* Save Button */}
                <div className="pt-4">
                  <button
                    onClick={handleSaveOverrideDescriptionSettings}
                    disabled={savingOverrideDescription}
                    className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingOverrideDescription ? "Saving..." : "Save Override Description Settings"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Offer Settings Card */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Offer Settings
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              Configure global Best Offer behavior for all listings.
            </p>

            {loadingOfferSettings ? (
              <div className="text-center py-4">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Loading offer settings...</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">
                      Allow Offers
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {allowOffers ? "Best Offer enabled for all listings" : "Best Offer disabled for all listings"}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowOffers}
                      onChange={(e) => setAllowOffers(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                {allowOffers && (
                  <div>
                    <label className="block text-sm font-medium text-gray-900 dark:text-white mb-2">
                      Minimum Offer Amount (USD)
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={minimumOfferAmount}
                        onChange={(e) => setMinimumOfferAmount(parseFloat(e.target.value) || 0)}
                        className="w-full pl-7 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="10.00"
                      />
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Offers below this amount are not accepted. Must be greater than 0 and lower than the listing price.
                    </p>
                  </div>
                )}

                <div className="pt-4">
                  <button
                    onClick={handleSaveOfferSettings}
                    disabled={savingOfferSettings}
                    className="px-6 py-2 bg-gray-800 dark:bg-gray-700 text-white rounded-md hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingOfferSettings ? "Saving..." : "Save Offer Settings"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

