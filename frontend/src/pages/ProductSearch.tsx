import { useState, useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { Html5QrcodeScanner } from "html5-qrcode"
import { apiRequest } from "@/lib/api"
import { removeKeywords, fetchBannedKeywords } from "@/lib/keyword-masker"

interface ProductData {
  title?: string
  price?: {
    value?: string
    currency?: string
  }
  condition?: string
  itemWebUrl?: string
  image?: {
    imageUrl?: string
  }
  [key: string]: any
}

type SearchType = "upc" | "title" | "any"

export default function ProductSearch() {
  const [upc, setUpc] = useState("")
  const [searchType, setSearchType] = useState<SearchType>("upc")
  // Media format to scope the search by (sticky across searches)
  const [searchMediaType, setSearchMediaType] = useState("DVD")
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState("")
  const [productData, setProductData] = useState<ProductData | null>(null)
  const [scannerActive, setScannerActive] = useState(false)
  const [scanningStatus, setScanningStatus] = useState("")
  const [debugLogs, setDebugLogs] = useState<string[]>([])
  const scannerRef = useRef<Html5QrcodeScanner | null>(null)
  const scannerElementId = "html5-qrcode-scanner"
  const errorCooldownRef = useRef<NodeJS.Timeout | null>(null)
  const upcInputRef = useRef<HTMLInputElement | null>(null)
  
  // Editable fields state
  const [isEditing, setIsEditing] = useState(false)
  const [editedTitle, setEditedTitle] = useState("")
  const [editedDescription, setEditedDescription] = useState("")
  const [editedCondition, setEditedCondition] = useState("")
  const [editedPrice, setEditedPrice] = useState("")
  // DVD catalog detail fields (combined into the eBay listing description)
  const [MediaType, setMediaType] = useState("")
  const [MediaYear, setMediaYear] = useState("")
  const [MediaPublisher, setMediaPublisher] = useState("")
  const [MediaGenre, setMediaGenre] = useState("")
  const [MediaRated, setMediaRated] = useState("")
  const [MediaLength, setMediaLength] = useState("")
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  // Shown when an exact UPC search finds nothing and we drop into manual entry
  const [noMatchWarning, setNoMatchWarning] = useState(false)
  
  // Listing state
  const [listingLoading, setListingLoading] = useState(false)
  const [listingSuccess, setListingSuccess] = useState<string | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)
  const [listedSku, setListedSku] = useState<string | null>(null)
  
  // Missing item specifics state
  const [missingAspects, setMissingAspects] = useState<string[]>([])
  const [aspectDefinitions, setAspectDefinitions] = useState<any[]>([])
  const [userProvidedAspects, setUserProvidedAspects] = useState<Record<string, string>>({})
  const [showAspectForm, setShowAspectForm] = useState(false)
  
  // SKU Preview state
  const [skuPreview, setSkuPreview] = useState<string>("")
  const [loadingSku, setLoadingSku] = useState(false)
  
  // Duplicate detection state
  const [hasDuplicates, setHasDuplicates] = useState(false)
  const [duplicateSku, setDuplicateSku] = useState<string>("")
  const [duplicateUpc, setDuplicateUpc] = useState<string>("")
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [duplicateCheckComplete, setDuplicateCheckComplete] = useState(false)
  const [increasingInventory, setIncreasingInventory] = useState(false)
  const [inventoryMessage, setInventoryMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)
  
  // Banned keywords state
  const [bannedKeywords, setBannedKeywords] = useState<string[]>([])
  const [keywordsLoaded, setKeywordsLoaded] = useState(false)
  
  // Mean price tracking state
  const [isMeanPrice, setIsMeanPrice] = useState(false)
  
  // Discount settings state
  const [discountAmount, setDiscountAmount] = useState<number>(3.0)
  const [minimumPrice, setMinimumPrice] = useState<number>(4.0)
  
  // Floor warning dialog state
  const [showFloorWarning, setShowFloorWarning] = useState(false)
  const [floorWarningData, setFloorWarningData] = useState<{ original: number; discounted: number; floor: number } | null>(null)
  
  // Edit mode settings state
  const [defaultEditMode, setDefaultEditMode] = useState<boolean>(false)
  
  // Override description settings state
  const [useOverrideDescription, setUseOverrideDescription] = useState<boolean>(false)
  const [universalOverrideDescription, setUniversalOverrideDescription] = useState<string>("")

  // Seller note editing setting + per-listing edited value (only editable in Edit Mode)
  const DEFAULT_SELLER_NOTE =
    "Please note: any mention of a digital copy or code may be expired and/or unavailable. This does not affect the quality or functionality of the Product."
  const [enableSellerNoteEditing, setEnableSellerNoteEditing] = useState<boolean>(false)
  const [universalSellerNoteText, setUniversalSellerNoteText] = useState<string>(DEFAULT_SELLER_NOTE)
  
  // Available conditions for dropdown
  const conditions = [
    "Used - Very Good",
    "Used - Excellent",
    "Used - Good",
    "Used - Acceptable",
    "Brand New",
    "Like New",
    "Very Good",
    "Good",
    "New Other",
    "New with Defects",
    "Manufacturer Refurbished",
    "Seller Refurbished",
    "For Parts or Not Working"
  ]
  
  // Helper function to get condition description text
  const getConditionDescription = (condition: string): string => {
    const descriptionMap: { [key: string]: string } = {
      "Brand New": "A brand-new, unused, unopened, undamaged item in its original packaging.",
      "Like New": "An item that looks like it just came from the store. The item may have been opened or used only once or twice, with no visible signs of wear. All accessories and original packaging are included.",
      "Very Good": "An item that has been used but remains in very good condition. The item shows minimal signs of wear and is fully functional with no defects. All major features work perfectly.",
      "Good": "An item that has been used and shows normal signs of wear. The item is fully functional but may have minor cosmetic issues such as light scratches, scuffs, or marks. All features work as expected.",
      "New Other": "A new, unused item with absolutely no signs of wear. The item may be missing original packaging or protective wrapping, or may be in original packaging but not sealed.",
      "New with Defects": "A new, unused item with defects or irregularities. The item may have cosmetic imperfections, be a factory second, or be damaged in a way that does not affect its operation.",
      "Manufacturer Refurbished": "An item that has been restored to working order by the manufacturer. This means the item has been inspected, cleaned, and repaired to meet manufacturer specifications and is in excellent condition.",
      "Seller Refurbished": "An item that has been restored to working order by the seller or a third party not approved by the manufacturer. This means the item has been inspected, cleaned, and repaired to full working order and is in excellent condition.",
      "Used - Excellent": "An item that has been used but is in excellent condition with no noticeable cosmetic or functional defects. The item may show minimal signs of use.",
      "Used - Very Good": "An item that has been used but remains in very good condition. The item shows some limited signs of wear but is fully functional with no defects.",
      "Used - Good": "An item that has been used and shows signs of wear. The item is fully functional but may have cosmetic issues such as scratches, scuffs, or minor marks.",
      "Used - Acceptable": "An item that has been used with obvious signs of wear. The item is fully functional but may have significant cosmetic defects.",
      "For Parts or Not Working": "An item that does not function as intended or is not fully operational. This item may be used for replacement parts or requires repair.",
    }
    
    return descriptionMap[condition] || ""
  }
  
  // Helper function to calculate discounted price with minimum floor
  const calculateDiscountedPrice = (originalPrice: string | number): { 
    original: number; 
    discounted: number; 
    actualDiscount: number; 
    hitFloor: boolean;
    rawDiscounted: number;
  } => {
    const original = typeof originalPrice === 'string' ? parseFloat(originalPrice) || 0 : originalPrice
    
    // Use settings values (with defaults if not loaded yet)
    const discount = discountAmount || 3.0
    const minPrice = minimumPrice || 4.0
    
    // Calculate discounted price (subtract fixed USD amount)
    const rawDiscounted = original - discount
    
    // Check if it hits the floor
    const hitFloor = rawDiscounted < minPrice
    
    // Apply minimum price floor
    const finalPrice = Math.max(rawDiscounted, minPrice)
    
    // Calculate actual discount amount (may be less than configured if minimum floor applies)
    const actualDiscount = original - finalPrice
    
    return {
      original,
      discounted: finalPrice,
      actualDiscount,
      hitFloor,
      rawDiscounted
    }
  }
  
  // Helper function to add debug log
  const addDebugLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    const logMessage = `[${timestamp}] ${message}`
    setDebugLogs((prev) => [...prev.slice(-9), logMessage]) // Keep last 10 logs
  }

  useEffect(() => {
    // Check if user has connected eBay account
    const checkEbayConnection = async () => {
      try {
        const res = await apiRequest("/api/ebay/check-connection")
        const data = await res.json()
        setIsConnected(data.connected)
      } catch (err) {
        setIsConnected(false)
      } finally {
        setChecking(false)
      }
    }

    checkEbayConnection()

    // Fetch banned keywords
    const loadBannedKeywords = async () => {
      console.log("[ProductSearch] Loading banned keywords...")
      const keywords = await fetchBannedKeywords()
      console.log("[ProductSearch] Banned keywords loaded:", keywords)
      setBannedKeywords(keywords)
      setKeywordsLoaded(true)
    }
    loadBannedKeywords()

    // Fetch discount settings
    const loadDiscountSettings = async () => {
      try {
        const res = await apiRequest("/api/settings/discount")
        if (res.ok) {
          const data = await res.json()
          setDiscountAmount(data.discountAmount || 3.0)
          setMinimumPrice(data.minimumPrice || 4.0)
        }
      } catch (error) {
        console.error("Failed to fetch discount settings:", error)
        // Use defaults if fetch fails
        setDiscountAmount(3.0)
        setMinimumPrice(4.0)
      }
    }
    loadDiscountSettings()

    // Fetch edit mode settings
    const loadEditModeSettings = async () => {
      try {
        const res = await apiRequest("/api/settings/edit-mode")
        if (res.ok) {
          const data = await res.json()
          setDefaultEditMode(data.defaultEditMode || false)
        }
      } catch (error) {
        console.error("Failed to fetch edit mode settings:", error)
        // Use default (false) if fetch fails
        setDefaultEditMode(false)
      }
    }
    loadEditModeSettings()

    // Fetch override description settings
    const loadOverrideDescriptionSettings = async () => {
      try {
        const res = await apiRequest("/api/settings/override-description")
        if (res.ok) {
          const data = await res.json()
          setUseOverrideDescription(data.useOverrideDescription || false)
          setUniversalOverrideDescription(data.overrideDescription || "")
          console.log("[OVERRIDE DEBUG] Loaded settings:", {
            useOverrideDescription: data.useOverrideDescription,
            overrideDescription: data.overrideDescription
          })
        }
      } catch (error) {
        console.error("Failed to fetch override description settings:", error)
        // Use default if fetch fails
        setUseOverrideDescription(false)
        setUniversalOverrideDescription("")
      }
    }
    loadOverrideDescriptionSettings()

    // Fetch seller note editing setting
    const loadSellerNoteEditingSettings = async () => {
      try {
        const res = await apiRequest("/api/settings/seller-note")
        if (res.ok) {
          const data = await res.json()
          setEnableSellerNoteEditing(data.enableSellerNoteEditing || false)
          setUniversalSellerNoteText(data.sellerNoteText || DEFAULT_SELLER_NOTE)
        }
      } catch (error) {
        console.error("Failed to fetch seller note editing settings:", error)
        setEnableSellerNoteEditing(false)
        setUniversalSellerNoteText(DEFAULT_SELLER_NOTE)
      }
    }
    loadSellerNoteEditingSettings()
  }, [])

  const performSearch = async (searchValue: string, typeOverride?: SearchType) => {
    const trimmedUpc = searchValue.trim()
    // Scanner forces a UPC search; the form uses the dropdown selection.
    const effectiveType: SearchType = typeOverride || searchType

    setError("")
    setProductData(null)
    setNoMatchWarning(false) // Clear any prior no-match warning
    setInventoryMessage(null) // Clear any previous inventory success/error messages
    setIncreasingInventory(false) // Reset inventory loading state
    setListingError(null) // Clear any previous listing errors
    setHasDuplicates(false) // Clear duplicate state for new search
    setDuplicateSku("")
    setDuplicateUpc("")
    setDuplicateCheckComplete(false) // Reset duplicate check status
    setUpc(trimmedUpc) // Update UPC state for display
    setLoading(true)

    try {
      const res = await apiRequest(
        `/api/ebay/search?upc=${encodeURIComponent(trimmedUpc)}&searchType=${effectiveType}&mediaType=${encodeURIComponent(searchMediaType)}`
      )
      const data = await res.json()

      if (!res.ok) {
        // If token refresh failed, update connection status
        if (data.needsReconnect) {
          setIsConnected(false)
        }
        // Exact UPC search found nothing in the catalog or on eBay: drop into
        // a blank manual-entry form instead of showing an error.
        if (res.status === 404 && effectiveType === "upc") {
          setNoMatchWarning(true)
          setProductData({
            title: "",
            price: { value: "", currency: "USD" },
            image: undefined,
            additionalImages: [],
          })
          setEditedTitle("")
          setEditedDescription("")
          setEditedCondition("Used - Very Good")
          setEditedPrice("")
          setMediaType(searchMediaType || "DVD") // default to the searched type
          setMediaYear("")
          setMediaPublisher("")
          setMediaGenre("")
          setMediaRated("")
          setMediaLength("")
          setIsMeanPrice(false)
          setIsEditing(true)
          setListingSuccess(null)
          fetchSkuPreview()
          return
        }
        throw new Error(data.error || "Failed to search product")
      }

      // Always default condition to "Used - Very Good" for new searches
      const defaultCondition = "Used - Very Good"
      
      // Update productData condition to show "Used - Very Good" in preview
      const productDataWithDefaultCondition = {
        ...data,
        condition: defaultCondition
      }
      
      setProductData(productDataWithDefaultCondition)
      // Initialize editable fields with product data
      // Apply keyword removal to title
      const processedTitle = removeKeywords(data.title || "", bannedKeywords)
      console.log("[handleSearch] Original title:", data.title)
      console.log("[handleSearch] Banned keywords:", bannedKeywords)
      console.log("[handleSearch] Processed title:", processedTitle)
      setEditedTitle(processedTitle)
      // If override description is enabled, start with empty description so user can type their own
      // Otherwise, populate from product data
      // Note: If user has previously saved an override description, it will be in productData and will be preserved when they edit again
      // Populate DVD detail fields from the catalog (or eBay for the description)
      const Media = data.dvdFields || {}
      // A catalog hit is a DVD; otherwise default to the searched media type.
      setMediaType(data.fromCatalog ? "DVD" : (searchMediaType || Media.type || ""))
      setMediaYear(Media.year || "")
      setMediaPublisher(Media.publisher || "")
      setMediaGenre(Media.genre || "")
      setMediaRated(Media.rated || "")
      setMediaLength(Media.length || "")
      setEditedDescription(
        useOverrideDescription
          ? ""
          : (Media.description || data.shortDescription || data.description || "")
      )
      setEditedCondition(defaultCondition)
      setEditedPrice(data.price?.value || "0.00")
      setIsMeanPrice(data._searchMetadata?.isMeanPrice || false)
      // Initialize edit mode based on user's default edit mode setting
      setIsEditing(defaultEditMode || false)
      setListingSuccess(null) // Clear success message for new search
      
      // Fetch SKU preview for this listing
      fetchSkuPreview()
      
      // Duplicate check matches inventory by UPC, so only run it for UPC
      // searches — a title/keyword value isn't a UPC to match against.
      if (effectiveType === "upc") {
        checkForDuplicates(trimmedUpc).catch(() => {
          // Don't block the user if check fails
        })
      }
    } catch (err: any) {
      setError(err.message || "Failed to search product")
    } finally {
      setLoading(false)
    }
  }
  
  const handleSaveEdit = () => {
    if (!productData) return
    
    console.log("[FRONTEND DEBUG] ========== SAVE EDIT CLICKED ==========")
    console.log("[FRONTEND DEBUG] Save Edit - Description:", JSON.stringify({
      useOverrideDescription: useOverrideDescription,
      editedDescription: editedDescription,
      editedDescriptionLength: editedDescription ? editedDescription.length : 0,
      editedDescriptionPreview: editedDescription ? editedDescription.substring(0, 100) : "empty",
      previousProductDataDescription: productData.description,
      previousProductDataShortDescription: productData.shortDescription,
      willSave: editedDescription
    }, null, 2))
    
    // Update product data with edited values
    setProductData({
      ...productData,
      title: editedTitle,
      description: editedDescription,
      shortDescription: editedDescription,
      condition: editedCondition,
      price: {
        ...productData.price,
        value: editedPrice,
        currency: productData.price?.currency || "USD"
      }
    })
    
    console.log("[FRONTEND DEBUG] Product data updated with description:", editedDescription)
    setIsEditing(false)
    setListingSuccess(null)
    setListingError(null)
  }
  
  const handleCancelEdit = () => {
    console.log("[FRONTEND DEBUG] ========== CANCEL EDIT CLICKED ==========")
    // Reset to original values, but always default condition to "Used - Very Good"
    if (productData) {
      setEditedTitle(removeKeywords(productData.title || "", bannedKeywords))
      // If override description is enabled:
      // - If productData has a saved description (from previous save), use it
      // - Otherwise, reset to empty so user can type new one
      // If override is disabled, reset to product data description
      if (useOverrideDescription) {
        // Check if there's a previously saved description in productData
        const savedDescription = productData.description || productData.shortDescription || ""
        console.log("[FRONTEND DEBUG] Cancel - Override enabled, resetting to saved description:", {
          savedDescription: savedDescription,
          savedDescriptionLength: savedDescription.length
        })
        setEditedDescription(savedDescription)
      } else {
        const normalDescription = productData.shortDescription || productData.description || ""
        console.log("[FRONTEND DEBUG] Cancel - Override disabled, resetting to normal description:", normalDescription)
        setEditedDescription(normalDescription)
      }
      setEditedCondition("Used - Very Good")
      setEditedPrice(productData.price?.value || "0.00")
    }
    setIsEditing(false)
    console.log("[FRONTEND DEBUG] Edit mode cancelled")
  }
  
  const handleClearProduct = () => {
    // Clear all product-related state
    setProductData(null)
    setUpc("") // Clear UPC from search bar
    setEditedTitle("")
    setEditedDescription("")
    setEditedCondition("")
    setEditedPrice("")
    setIsMeanPrice(false) // Clear mean price flag
    setIsEditing(false)
    setListingLoading(false)
    setListingSuccess(null)
    setListingError(null)
    setListedSku(null) // Clear previous SKU on manual clear
    setMissingAspects([])
    setAspectDefinitions([])
    setUserProvidedAspects({})
    setShowAspectForm(false)
    setError("")
    setSkuPreview("") // Clear SKU preview
    setHasDuplicates(false) // Clear duplicate detection
    setDuplicateSku("")
    setDuplicateUpc("")
    setDuplicateCheckComplete(false) // Clear duplicate check status
    setInventoryMessage(null) // Clear inventory increase message

    // Clear Media detail fields too
    setMediaType("")
    setMediaYear("")
    setMediaPublisher("")
    setMediaGenre("")
    setMediaRated("")
    setMediaLength("")
    setNoMatchWarning(false)

    // After clearing, refocus UPC input so the next barcode scan goes straight into it
    if (upcInputRef.current) {
      upcInputRef.current.focus()
      upcInputRef.current.select()
    }
  }

  // Combine the structured Media fields + description into the labeled HTML block
  // sent as the eBay listing description.
  const buildCombinedDescription = (): string => {
    const rows: string[] = []
    if (MediaType.trim()) rows.push(`<b>Type:</b> ${MediaType.trim()}`)
    if (MediaYear.trim()) rows.push(`<b>Year:</b> ${MediaYear.trim()}`)
    if (MediaPublisher.trim()) rows.push(`<b>Publisher:</b> ${MediaPublisher.trim()}`)
    if (MediaGenre.trim()) rows.push(`<b>Genre:</b> ${MediaGenre.trim()}`)
    if (MediaRated.trim()) rows.push(`<b>Rated:</b> ${MediaRated.trim()}`)
    if (MediaLength.trim()) rows.push(`<b>Length:</b> ${MediaLength.trim()}`)
    const header = rows.join("<br>\n")
    const desc = (editedDescription || "").trim()
    if (!header) return desc
    return desc ? `${header}<br><br>\n${desc}` : header
  }

  // Media type -> eBay leaf category id.
  const MEDIA_CATEGORY_IDS: Record<string, string> = {
    DVD: "617", // DVDs & Blu-ray Discs
    CD: "176984",
    Cassette: "176983",
    VHS: "309",
  }

  // Change the media type. Selecting "DVD" runs a catalog check and, if the
  // item is in the catalog, populates the fields from it.
  const handleMediaTypeChange = async (value: string) => {
    setMediaType(value)
    if (value !== "DVD") return
    const lookupUpc = (upc || productData?.gtin || "").trim()
    if (!lookupUpc) return
    try {
      const res = await apiRequest(`/api/catalog/dvd?upc=${encodeURIComponent(lookupUpc)}`)
      const data = await res.json()
      if (res.ok && data.found) {
        const f = data.fields || {}
        if (data.title) setEditedTitle(data.title)
        if (f.description) setEditedDescription(f.description)
        if (f.year) setMediaYear(f.year)
        if (f.publisher) setMediaPublisher(f.publisher)
        if (f.genre) setMediaGenre(f.genre)
        if (f.rated) setMediaRated(f.rated)
        if (f.length) setMediaLength(f.length)
      }
    } catch {
      // Non-fatal: catalog check is best-effort
    }
  }

  // Upload a photo to Supabase Storage and use it as the listing image.
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !productData) return
    setUploadingPhoto(true)
    setListingError(null)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await apiRequest("/api/upload-photo", { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Photo upload failed")
      setProductData({ ...productData, image: { imageUrl: data.url } })
    } catch (err: any) {
      setListingError(err.message || "Photo upload failed")
    } finally {
      setUploadingPhoto(false)
      e.target.value = "" // allow re-selecting the same file
    }
  }

  // Save the current item to the DVD catalog ("This is a DVD").
  const saveToDvdCatalog = async () => {
    const catalogUpc = (upc || productData?.gtin || "").trim()
    const title = (editedTitle || productData?.title || "").trim()
    if (!catalogUpc || !title) return
    try {
      await apiRequest("/api/catalog/dvd", {
        method: "POST",
        body: JSON.stringify({
          upc: catalogUpc,
          title,
          type: MediaType,
          year: MediaYear,
          description: editedDescription,
          publisher: MediaPublisher,
          genre: MediaGenre,
          rated: MediaRated,
          length: MediaLength,
          images: productData?.image?.imageUrl || null,
        }),
      })
    } catch {
      // Non-fatal: don't block listing if the catalog write fails
    }
  }
  
  // Check if products with this UPC already exist in eBay inventory
  const checkForDuplicates = async (upcCode: string) => {
    if (!upcCode || upcCode.trim() === "") {
      return
    }
    
    const trimmedUpc = upcCode.trim()
    setCheckingDuplicates(true)
    setDuplicateCheckComplete(false)
    setHasDuplicates(false)
    setDuplicateSku("")
    setDuplicateUpc("")
    
    try {
      const apiUrl = `/api/ebay/check-duplicate?upc=${encodeURIComponent(trimmedUpc)}`
      const res = await apiRequest(apiUrl)
      
      if (res.ok) {
        const data = await res.json()
        
        if (data.hasDuplicates && data.duplicates && data.duplicates.length > 0) {
          // Show first duplicate SKU
          setHasDuplicates(true)
          const duplicateSkuValue = data.duplicates[0].sku || ""
          setDuplicateSku(duplicateSkuValue)
          setDuplicateUpc(data.upc || trimmedUpc)
          // Update SKU preview to show duplicate SKU instead of next SKU
          if (duplicateSkuValue) {
            setSkuPreview(duplicateSkuValue)
          }
        } else {
          setHasDuplicates(false)
          setDuplicateSku("")
          setDuplicateUpc("")
          // Reset to normal SKU preview if no duplicates
          fetchSkuPreview(false)
        }
        setDuplicateCheckComplete(true)
      } else {
        // If API call failed, clear duplicate state
        setHasDuplicates(false)
        setDuplicateSku("")
        setDuplicateUpc("")
        setDuplicateCheckComplete(true)
      }
    } catch (error) {
      // On error, clear duplicate state (don't show false positives)
      setHasDuplicates(false)
      setDuplicateSku("")
      setDuplicateUpc("")
      setDuplicateCheckComplete(true)
    } finally {
      setCheckingDuplicates(false)
    }
  }
  
  // Handle increasing inventory for existing listing
  const handleIncreaseInventory = async () => {
    if (!duplicateSku && !duplicateUpc && !upc) {
      setInventoryMessage({ type: "error", text: "No product information found to increase inventory" })
      return
    }
    
    setIncreasingInventory(true)
    setInventoryMessage(null)
    
    try {
      const res = await apiRequest("/api/ebay/increase-inventory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          sku: duplicateSku || "",
          upc: duplicateUpc || upc || "" // Pass UPC to find published listing
        }),
      })
      
      const data = await res.json()
      
      if (res.ok) {
        setInventoryMessage({ 
          type: "success", 
          text: `✓ Inventory increased successfully! New quantity: ${data.newQuantity}` 
        })
      } else {
        setInventoryMessage({ 
          type: "error", 
          text: data.error || "Failed to increase inventory" 
        })
      }
    } catch (error: any) {
      setInventoryMessage({ 
        type: "error", 
        text: error.message || "Failed to increase inventory" 
      })
    } finally {
      setIncreasingInventory(false)
    }
  }
  
  // Fetch SKU preview for the next listing
  const fetchSkuPreview = async (updatePreviousSku = true) => {
    setLoadingSku(true)
    try {
      const res = await apiRequest("/api/settings/sku")
      if (res.ok) {
        const data = await res.json()
        const prefix = data.skuPrefix || "SKU"
        const counter = data.nextSkuCounter || 1
        const preview = `${prefix}-0000${counter}`
        setSkuPreview(preview)
        
        // Also set the previous SKU (last listed product) if requested
        if (updatePreviousSku) {
          if (counter > 1) {
            const previousCounter = counter - 1
            const previousSku = `${prefix}-0000${previousCounter}`
            setListedSku(previousSku)
          } else {
            setListedSku(null) // No previous SKU if this is the first one
          }
        }
      }
    } catch (error) {
      console.error("Failed to fetch SKU preview:", error)
    } finally {
      setLoadingSku(false)
    }
  }
  
  const handleListOnEbay = async (additionalAspects?: Record<string, string>, bypassFloorWarning?: boolean) => {
    if (!productData) return
    
    // Check if price hits floor and show warning dialog (unless bypassed)
    const listingPrice = editedPrice || productData.price?.value || "0.00"
    const priceInfo = calculateDiscountedPrice(listingPrice)
    
    if (priceInfo.hitFloor && !bypassFloorWarning) {
      // Show floor warning dialog
      setFloorWarningData({
        original: priceInfo.original,
        discounted: priceInfo.discounted,
        floor: minimumPrice
      })
      setShowFloorWarning(true)
      return
    }
    
    setListingLoading(true)
    setListingError(null)
    setListingSuccess(null)
    // Don't clear showAspectForm here - let it be cleared only after successful listing
    // This preserves aspectDefinitions state for retry attempts
    
    try {
      // Merge user-provided aspects with existing aspects
      const currentAspects = productData.localizedAspects || productData.aspects || {}
      const mergedAspects: Record<string, string[]> = {}
      
      // First, copy existing aspects and ensure they're in array format
      Object.keys(currentAspects).forEach(key => {
        const value = currentAspects[key]
        if (value) {
          if (Array.isArray(value)) {
            // Filter out empty values
            const nonEmptyValues = value.filter(v => v && String(v).trim() !== "")
            if (nonEmptyValues.length > 0) {
              mergedAspects[key] = nonEmptyValues.map(v => String(v).trim())
            }
          } else if (String(value).trim() !== "") {
            mergedAspects[key] = [String(value).trim()]
          }
        }
      })
      
      // Add user-provided aspects (these will overwrite existing ones)
      // Map user-provided aspect names to exact names from aspectDefinitions if available
      if (additionalAspects && Object.keys(additionalAspects).length > 0) {
        console.log("Merging user-provided aspects:", additionalAspects)
        console.log("Available aspect definitions:", aspectDefinitions.map((a: any) => a.name))
        
        Object.keys(additionalAspects).forEach(userKey => {
          const value = additionalAspects[userKey]
          if (value && typeof value === 'string' && value.trim() !== "") {
            // Use the exact aspect name from aspectDefinitions if available
            // This ensures we match exactly what eBay expects
            // Try multiple matching strategies to find the correct aspect name
            let aspectDef = aspectDefinitions.find((a: any) => 
              a.name && a.name.toLowerCase() === userKey.toLowerCase()
            )
            
            // If not found, try partial matching
            if (!aspectDef && aspectDefinitions.length > 0) {
              aspectDef = aspectDefinitions.find((a: any) => 
                a.name && (
                  a.name.toLowerCase().includes(userKey.toLowerCase()) ||
                  userKey.toLowerCase().includes(a.name.toLowerCase())
                )
              )
            }
            
            // If still not found, try matching against missingAspects (which contains the exact eBay names)
            if (!aspectDef && missingAspects.length > 0) {
              const matchingMissingAspect = missingAspects.find((a: string) => 
                a.toLowerCase() === userKey.toLowerCase() ||
                a.toLowerCase().includes(userKey.toLowerCase()) ||
                userKey.toLowerCase().includes(a.toLowerCase())
              )
              if (matchingMissingAspect) {
                // Use the exact name from missingAspects
                mergedAspects[matchingMissingAspect] = [value.trim()]
                console.log(`Mapped aspect "${userKey}" -> "${matchingMissingAspect}" (from missingAspects) with value:`, value.trim())
                return // Skip the rest of this iteration
              }
            }
            
            const exactAspectName = aspectDef ? aspectDef.name : userKey
            
            // Ensure the value is stored as an array (eBay format)
            // This overwrites any existing value for this aspect
            mergedAspects[exactAspectName] = [value.trim()]
            console.log(`Mapped aspect "${userKey}" -> "${exactAspectName}" with value:`, value.trim())
          }
        })
        
        console.log("Final merged aspects:", mergedAspects)
      }
      
      // Calculate discounted price for listing
      const listingPrice = editedPrice || productData.price?.value || "0.00"
      const priceInfo = calculateDiscountedPrice(listingPrice)
      const finalListingPrice = priceInfo.discounted.toFixed(2)
      
      // DEBUG: Log what we're sending for description
      // When override is enabled: use editedDescription, but fall back to eBay description if empty (to avoid empty listing errors)
      // When override is disabled: use editedDescription or fall back to product data
      console.log("[FRONTEND DEBUG] ========== LIST ON EBAY CLICKED ==========")
      console.log("[FRONTEND DEBUG] Listing - Description state before processing:", JSON.stringify({
        useOverrideDescription: useOverrideDescription,
        editedDescription: editedDescription,
        editedDescriptionLength: editedDescription ? editedDescription.length : 0,
        editedDescriptionPreview: editedDescription ? editedDescription.substring(0, 100) : "empty",
        editedDescriptionIsEmpty: !editedDescription || editedDescription.trim().length === 0,
        productDataShortDescription: productData.shortDescription,
        productDataDescription: productData.description,
        productDataDescriptionLength: productData.description ? productData.description.length : 0
      }, null, 2))
      
      // Description logic:
      // 1. If useOverrideDescription is enabled and universalOverrideDescription is set, use that
      // 2. If user manually edited the description (editedDescription), use that
      // 3. Otherwise, fall back to eBay product description
      let descriptionToSend: string
      let descriptionSource: string
      
      if (useOverrideDescription && universalOverrideDescription && universalOverrideDescription.trim().length > 0) {
        // Universal override is enabled and has content - use it
        descriptionToSend = universalOverrideDescription
        descriptionSource = "UNIVERSAL_OVERRIDE"
      } else {
        // Combine the structured Media fields + description into the labeled
        // HTML block. Falls back to the eBay description if all are empty.
        descriptionToSend =
          buildCombinedDescription() ||
          productData.shortDescription ||
          productData.description ||
          ""
        descriptionSource = "COMBINED_Media_FIELDS"
      }
      
      console.log("[FRONTEND DEBUG] Listing to eBay - Final Description Decision:", JSON.stringify({
        useOverrideDescription: useOverrideDescription,
        universalOverrideDescription: universalOverrideDescription,
        universalOverrideDescriptionLength: universalOverrideDescription ? universalOverrideDescription.length : 0,
        editedDescription: editedDescription,
        editedDescriptionLength: editedDescription ? editedDescription.length : 0,
        productDataShortDescription: productData.shortDescription,
        productDataDescription: productData.description,
        descriptionToSend: descriptionToSend,
        descriptionToSendPreview: descriptionToSend ? descriptionToSend.substring(0, 100) : "empty",
        descriptionLength: descriptionToSend.length,
        isEmpty: !descriptionToSend || descriptionToSend.trim().length === 0,
        descriptionSource: descriptionSource
      }, null, 2))

      const conditionDescriptionToSend =
        enableSellerNoteEditing ? universalSellerNoteText : undefined

      console.log("[FRONTEND DEBUG] Listing - Condition Description Decision:", JSON.stringify({
        enableSellerNoteEditing,
        isEditing,
        willSendConditionDescription: conditionDescriptionToSend !== undefined,
        conditionDescriptionLength: conditionDescriptionToSend ? conditionDescriptionToSend.length : 0,
        conditionDescriptionPreview: conditionDescriptionToSend
          ? conditionDescriptionToSend.substring(0, 120)
          : "default_on_backend",
      }, null, 2))

      const response = await apiRequest("/api/ebay/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Editable fields
          title: editedTitle || productData.title || "",
          description: descriptionToSend,
          price: finalListingPrice, // Use discounted price with minimum floor
          condition: editedCondition || "Used - Very Good",
          conditionDescription: conditionDescriptionToSend,
          
          // Images - primary and additional
          imageUrl: productData.image?.imageUrl || "",
          additionalImages: productData.additionalImages || [],
          
          // Category: prefer the eBay category mapped from the selected media
          // type, falling back to the Browse API category.
          categoryId: MEDIA_CATEGORY_IDS[MediaType] || productData.categoryId || "",
          categories: productData.categories || [],
          
          // Product identifiers
          upc: upc || productData.gtin || "", // Pass the scanned UPC
          ean: productData.ean || "",
          isbn: productData.isbn || "",
          mpn: productData.mpn || "",
          brand: productData.brand || "",
          
          // eBay Product ID for better catalog matching
          epid: productData.epid || "",
          
          // Product aspects (item specifics) - merged with user-provided
          aspects: mergedAspects,
          
          // Condition ID from Browse API
          conditionId: productData.conditionId || "",
          
          // Short description (may contain Platform info)
          shortDescription: productData.shortDescription || "",
          
          // Reference URL (for debugging/logging)
          itemWebUrl: productData.itemWebUrl || "",
        }),
      })
      
      let data
      try {
        data = await response.json()
      } catch (jsonError) {
        throw new Error(`Failed to parse response: ${response.status} ${response.statusText}`)
      }
      
      if (!response.ok) {
        // DEBUG: Log error response
        console.error("[FRONTEND DEBUG] Listing failed with status:", response.status)
        console.error("[FRONTEND DEBUG] Error response data:", data)
        console.error("[FRONTEND DEBUG] Error details:", {
          error: data.error,
          errorCode: data.errorCode,
          received: data.received,
          details: data.details
        })
        
        // Check if this is a missing item specifics error
        if (data.action === "missing_item_specifics" && data.missingItemSpecifics) {
          setMissingAspects(data.missingItemSpecifics)
          // Preserve existing aspectDefinitions if new ones aren't provided, otherwise update
          if (data.aspectDefinitions && data.aspectDefinitions.length > 0) {
            setAspectDefinitions(data.aspectDefinitions)
          } else if (aspectDefinitions.length === 0) {
            // Only set empty array if we don't have any existing definitions
            setAspectDefinitions([])
          }
          // If we have existing definitions and no new ones, keep the existing ones
          
          // Pre-fill form with user's previous input if retrying, otherwise use suggested values
          const prefillAspects: Record<string, string> = {}
          
          // First, preserve user's previous input if this is a retry
          if (userProvidedAspects && Object.keys(userProvidedAspects).length > 0) {
            Object.keys(userProvidedAspects).forEach(key => {
              if (userProvidedAspects[key] && userProvidedAspects[key].trim() !== "") {
                // Map to correct aspect name from missingAspects or aspectDefinitions
                const matchingAspect = data.missingItemSpecifics.find((a: string) => 
                  a.toLowerCase() === key.toLowerCase() ||
                  a.toLowerCase().includes(key.toLowerCase()) ||
                  key.toLowerCase().includes(a.toLowerCase())
                )
                if (matchingAspect) {
                  prefillAspects[matchingAspect] = userProvidedAspects[key]
                } else {
                  prefillAspects[key] = userProvidedAspects[key]
                }
              }
            })
          }
          
          // Then, fill in suggested values for any missing aspects
          const currentDefs = data.aspectDefinitions || aspectDefinitions
          currentDefs.forEach((def: any) => {
            if (def.suggestedValue && !prefillAspects[def.name]) {
              prefillAspects[def.name] = def.suggestedValue
            }
          })
          
          setUserProvidedAspects(prefillAspects)
          
          setShowAspectForm(true)
          setListingError(null) // Clear error to show form instead
          setListingLoading(false)
          return // Don't throw error, show form instead
        }
        
        // Log the error for debugging
        console.error("Listing error:", {
          status: response.status,
          error: data.error,
          errorCode: data.errorCode,
          needsReconnect: data.needsReconnect,
          details: data.details,
          rawEbayError: data.rawEbayError
        })
        
        // Display RAW eBay error for debugging
        let errorMessage = "eBay API Error:\n\n"
        
        // Show raw eBay error if available
        if (data.rawEbayError) {
          errorMessage += "RAW eBay Response:\n" + JSON.stringify(data.rawEbayError, null, 2) + "\n\n"
        }
        
        // Show our processed error
        errorMessage += "Error: " + (data.error || "Failed to list product on eBay") + "\n"
        
        if (data.errorCode) {
          errorMessage += "Error Code: " + data.errorCode + "\n"
        }
        
        if (data.hint) {
          errorMessage += "Hint: " + data.hint
        }
        
        // Add received data for debugging if available
        if (data.received) {
          console.error("Received data:", data.received)
        }
        if (data.details) {
          console.error("eBay API Error Details:", JSON.stringify(data.details, null, 2))
          // Also log individual errors if available
          if (data.details.errors && Array.isArray(data.details.errors)) {
            data.details.errors.forEach((err: any, index: number) => {
              console.error(`Error ${index + 1}:`, {
                errorId: err.errorId,
                domain: err.domain,
                category: err.category,
                message: err.message,
                longMessage: err.longMessage,
                parameters: err.parameters
              })
            })
          }
        }
        throw new Error(errorMessage)
      }
      
      // Only clear aspect form and definitions on successful listing
      setShowAspectForm(false)
      setMissingAspects([])
      setAspectDefinitions([])
      setUserProvidedAspects({})
      
      setListingSuccess(data.listingUrl || data.message || "Product listed successfully!")
      // If the media type is DVD, save/update the catalog with these details
      if (MediaType === "DVD") {
        saveToDvdCatalog().catch(() => {})
      }
      // Capture the SKU that was used for this listing and calculate next SKU
      if (data.sku) {
        setListedSku(data.sku)
        
        // Calculate the next SKU based on the returned SKU
        // Format: PREFIX-0000XXX where XXX is the counter
        const skuParts = data.sku.split('-0000')
        if (skuParts.length === 2) {
          const prefix = skuParts[0]
          const currentCounter = parseInt(skuParts[1])
          if (!isNaN(currentCounter)) {
            const nextCounter = currentCounter + 1
            const nextSku = `${prefix}-0000${nextCounter}`
            setSkuPreview(nextSku)
          } else {
            // Fallback to fetching from API
            fetchSkuPreview(false)
          }
        } else {
          // Fallback to fetching from API
          fetchSkuPreview(false)
        }
      } else {
        // Fallback to fetching from API
        fetchSkuPreview(false)
      }
      // Keep user in edit mode after listing so they can make changes and list again
      // setIsEditing(false) - Removed: users can now type and list directly without saving
    } catch (err: any) {
      setListingError(err.message || "Failed to list product on eBay")
    } finally {
      setListingLoading(false)
    }
  }
  
  const handleSubmitAspects = () => {
    // Validate all required aspects are filled
    const allFilled = missingAspects.every(aspect => {
      const aspectDef = aspectDefinitions.find((a: any) => a.name === aspect)
      if (aspectDef && aspectDef.values && aspectDef.values.length > 0) {
        // Has predefined values, check if user selected one
        return userProvidedAspects[aspect] && userProvidedAspects[aspect].trim() !== ""
      }
      // Free text, just check if filled
      return userProvidedAspects[aspect] && userProvidedAspects[aspect].trim() !== ""
    })
    
    if (!allFilled) {
      setListingError("Please fill in all required item specifics before listing.")
      return
    }
    
    // Retry listing with user-provided aspects
    handleListOnEbay(userProvidedAspects)
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    await performSearch(upc)
  }

  const startScanner = () => {
    addDebugLog("🔍 startScanner() called")
    addDebugLog(`🔍 scannerActive: ${scannerActive}, scannerRef exists: ${!!scannerRef.current}`)
    
    if (scannerActive || scannerRef.current) {
      addDebugLog("⚠️ Scanner already active, returning early")
      return
    }

    addDebugLog("🔍 Setting scanner state to active")
    setScannerActive(true)
    setError("")
    setScanningStatus("Initializing camera...")
    setDebugLogs([]) // Clear previous logs
    addDebugLog("✅ Scanner state updated")
  }

  const stopScanner = () => {
    addDebugLog("🔍 stopScanner() called")
    addDebugLog(`🔍 scannerRef.current exists: ${!!scannerRef.current}`)
    
    // Clear error cooldown timeout if exists
    if (errorCooldownRef.current) {
      clearTimeout(errorCooldownRef.current)
      errorCooldownRef.current = null
    }
    
    if (scannerRef.current) {
      addDebugLog("🔍 Clearing scanner instance...")
        scannerRef.current.clear().catch((err) => {
          addDebugLog(`❌ Error clearing scanner: ${err?.message || "Unknown error"}`)
        })
      scannerRef.current = null
      addDebugLog("✅ Scanner instance cleared")
    }
    
    addDebugLog("🔍 Setting scanner state to inactive")
    setScannerActive(false)
    setScanningStatus("")
    
    // Clear the scanner element
    const element = document.getElementById(scannerElementId)
    if (element) {
      addDebugLog("🔍 Clearing scanner DOM element")
      element.innerHTML = ""
      addDebugLog("✅ Scanner DOM element cleared")
    } else {
      addDebugLog("⚠️ Scanner DOM element not found for cleanup")
    }
    
    addDebugLog("✅ stopScanner() complete")
  }

  // Initialize scanner when modal is rendered
  useEffect(() => {
    if (!scannerActive) {
      // Clean up if scanner was stopped
      if (scannerRef.current) {
        scannerRef.current.clear().catch(() => {})
        scannerRef.current = null
      }
      return
    }

    // Add global error handler to catch library errors
    const handleGlobalError = (event: ErrorEvent) => {
      // Check if error is related to toString and scanner
      if (event.message && (event.message.includes('toString') || event.message.includes('is not an object')) && scannerActive) {
        try {
          addDebugLog(`⚠️ Caught global error: ${event.message || 'Unknown error'}`)
          // Prevent the error from breaking the scanner
          if (event.preventDefault) {
            event.preventDefault()
          }
          // Update status but don't stop scanning
          setScanningStatus("Scanning...")
          return false
        } catch (err) {
          // If error handling fails, just log and continue
          console.error("Error in global error handler:", err)
          return false
        }
      }
      return true
    }
    
    // Also add unhandled rejection handler for promise errors
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (event.reason && typeof event.reason === 'object') {
        const errorMsg = event.reason?.message || String(event.reason)
        if ((errorMsg.includes('toString') || errorMsg.includes('is not an object')) && scannerActive) {
          try {
            addDebugLog(`⚠️ Caught unhandled promise rejection: ${errorMsg}`)
            setScanningStatus("Scanning...")
            event.preventDefault()
          } catch (err) {
            console.error("Error in unhandled rejection handler:", err)
          }
        }
      }
    }

    // Add the error handlers
    window.addEventListener('error', handleGlobalError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)

    // Wait for DOM to be ready
    addDebugLog("🔍 Setting up scanner initialization timer...")
    const timer = setTimeout(() => {
      addDebugLog("🔍 Timer fired, looking for scanner element...")
      const element = document.getElementById(scannerElementId)
      addDebugLog(`🔍 Element lookup result: ${!!element}`)
      addDebugLog(`🔍 Element ID searched: ${scannerElementId}`)
      
      if (!element) {
        addDebugLog("❌ Scanner element not found!")
        const similarIds = Array.from(document.querySelectorAll('[id*="scanner"], [id*="qr"], [id*="barcode"]')).map(el => el.id)
        addDebugLog(`❌ Available similar IDs: ${similarIds.join(", ") || "none"}`)
        setError("Failed to initialize scanner. Please try again.")
        setScannerActive(false)
        return
      }

      addDebugLog("✅ Scanner element found, clearing content...")
      // Clear any existing content
      element.innerHTML = ""
      addDebugLog("✅ Scanner element cleared")

      try {
        addDebugLog("🔍 Starting scanner initialization...")
        addDebugLog(`🔍 Scanner element ID: ${scannerElementId}`)
        addDebugLog(`🔍 Scanner element found: ${!!element}`)
        
        // Optimized configuration for barcode scanning (especially 1D barcodes like UPC)
        const config = {
          qrbox: {
            width: 400,  // Wider box for 1D barcodes (UPC/EAN)
            height: 120, // Reduced height for more compact scan area
          },
          fps: 20, // Higher FPS for faster scanning
          aspectRatio: 1.777778, // 16:9 aspect ratio for better camera quality
          disableFlip: true, // Disable flip for better performance
          supportedScanTypes: [0, 1], // Support both 1D and 2D barcodes
          rememberLastUsedCamera: true, // Remember camera selection
          showTorchButtonIfSupported: true, // Show torch button if available
          showZoomSliderIfSupported: true, // Show zoom slider if available
        }
        
        addDebugLog(`🔍 Scanner config: ${JSON.stringify(config)}`)
        
        const scanner = new Html5QrcodeScanner(
          scannerElementId,
          config,
          true // verbose - ENABLED FOR DEBUGGING
        )

        addDebugLog(`✅ Scanner instance created: ${!!scanner}`)
        scannerRef.current = scanner

        addDebugLog("🔍 Starting scanner.render()...")
        try {
          scanner.render(
            (decodedText: any) => {
            try {
              // Successfully scanned - validate it looks like a UPC
              // Add comprehensive defensive checks for all possible value types
              if (decodedText === null || decodedText === undefined) {
                addDebugLog("⚠️ Decoded text is null or undefined")
                return
              }
              
              // Convert to string safely - handle all types
              let decodedTextStr = ""
              if (typeof decodedText === 'string') {
                decodedTextStr = decodedText
              } else if (typeof decodedText === 'number' || typeof decodedText === 'boolean') {
                decodedTextStr = String(decodedText)
              } else if (typeof decodedText === 'object') {
                // For objects, try to extract meaningful string
                try {
                  if (decodedText.toString && typeof decodedText.toString === 'function') {
                    decodedTextStr = decodedText.toString()
                  } else {
                    decodedTextStr = JSON.stringify(decodedText)
                  }
                } catch {
                  addDebugLog("⚠️ Failed to convert decoded text object to string")
                  return
                }
              } else {
                // Fallback for any other type
                try {
                  decodedTextStr = String(decodedText)
                } catch {
                  addDebugLog("⚠️ Failed to convert decoded text to string")
                  return
                }
              }
              
              // Validate the string is not empty after conversion
              if (!decodedTextStr || decodedTextStr.trim().length === 0) {
                addDebugLog("⚠️ Decoded text is empty after conversion")
                return
              }
              
              addDebugLog("✅ Barcode detected!")
              addDebugLog(`✅ Raw decoded text: "${decodedTextStr}"`)
              addDebugLog(`✅ Decoded text type: ${typeof decodedTextStr}, length: ${decodedTextStr.length}`)
              
              setScanningStatus("Barcode/QR Code detected!")
              const cleanedText = decodedTextStr.trim()
              addDebugLog(`✅ Cleaned text: "${cleanedText}"`)
              
              // Basic validation: UPC codes are typically 8, 12, or 13 digits
              const isValidUPC = /^\d{8,13}$/.test(cleanedText)
              addDebugLog(`✅ Is valid UPC format: ${isValidUPC}`)
              
              if (isValidUPC) {
                addDebugLog(`✅ Setting UPC value: ${cleanedText}`)
                setUpc(cleanedText)
                // Small delay to show success message
                setTimeout(() => {
                  addDebugLog("🔍 Stopping scanner after successful scan")
                  setScanningStatus("Searching...")
                  stopScanner()
                  // Auto-trigger search after scanning
                  addDebugLog("🔍 Auto-triggering search...")
                  performSearch(cleanedText, "upc")
                }, 500)
              } else {
                // Not a valid UPC format, but still use it (might be EAN or other format)
                addDebugLog(`⚠️ Not standard UPC format, but using value: ${cleanedText}`)
                setUpc(cleanedText)
                setTimeout(() => {
                  addDebugLog("🔍 Stopping scanner after scan (non-UPC format)")
                  setScanningStatus("Searching...")
                  stopScanner()
                  // Auto-trigger search after scanning
                  addDebugLog("🔍 Auto-triggering search...")
                  performSearch(cleanedText, "upc")
                }, 500)
              }
            } catch (err: any) {
              // Comprehensive error handling
              const errMsg = err && typeof err === 'object' && 'message' in err 
                ? String(err.message) 
                : String(err || "Unknown error")
              addDebugLog(`❌ Error processing decoded text: ${errMsg}`)
              console.error("Error processing barcode scan:", err)
              // Don't stop scanning on error, just log it
            }
          },
          (errorMessage: any) => {
            try {
              // Error callback - update status for user feedback
              // Convert errorMessage to string safely with comprehensive type handling
              let errorStr = ""
              
              // Handle all possible types safely
              if (errorMessage === null || errorMessage === undefined) {
                errorStr = ""
              } else if (typeof errorMessage === 'string') {
                errorStr = errorMessage
              } else if (typeof errorMessage === 'number' || typeof errorMessage === 'boolean') {
                errorStr = String(errorMessage)
              } else if (typeof errorMessage === 'object') {
                // For objects, safely convert to string
                try {
                  if (errorMessage instanceof Error) {
                    // Safely get message or toString
                    try {
                      errorStr = (errorMessage.message && String(errorMessage.message)) || 
                                (typeof errorMessage.toString === 'function' ? errorMessage.toString() : "[Error]")
                    } catch {
                      errorStr = "[Error]"
                    }
                  } else if (errorMessage && typeof errorMessage.toString === 'function') {
                    // Double check errorMessage exists and toString is callable before calling it
                    try {
                      errorStr = errorMessage.toString()
                      // Validate the result is actually a string
                      if (typeof errorStr !== 'string') {
                        errorStr = String(errorStr)
                      }
                    } catch (toStringErr) {
                      // If toString throws, try JSON.stringify as fallback
                      try {
                        errorStr = JSON.stringify(errorMessage)
                      } catch {
                        errorStr = "[Error object - conversion failed]"
                      }
                    }
                  } else {
                    errorStr = JSON.stringify(errorMessage)
                  }
                } catch (err) {
                  // If anything fails, use a safe fallback
                  errorStr = "[Error object]"
                }
              } else {
                // Fallback for any other type
                try {
                  errorStr = String(errorMessage)
                } catch {
                  errorStr = "[Unknown error]"
                }
              }
              
              // NotFoundException is normal - no barcode in frame yet
              // Don't log every NotFoundException to avoid spam
              if (!errorStr || errorStr.includes("NotFoundException") || errorStr === "") {
                setScanningStatus("Scanning...")
                return
              }
              
              // Clear any existing cooldown
              if (errorCooldownRef.current) {
                clearTimeout(errorCooldownRef.current)
              }
              
              addDebugLog(`⚠️ Scanner error: ${errorStr}`)
              setScanningStatus("Error detected - pausing...")
              
              // Add setTimeout to pause scanning after error before continuing
              errorCooldownRef.current = setTimeout(() => {
                addDebugLog("✅ Resuming scan after error cooldown")
                // Show scanning status
                if (errorStr.includes("No MultiFormat Readers")) {
                  addDebugLog("⚠️ No MultiFormat Readers error")
                  setScanningStatus("Waiting for barcode...")
                } else {
                  addDebugLog("⚠️ Other scanning error")
                  setScanningStatus("Scanning...")
                }
                errorCooldownRef.current = null
              }, 1000) // Wait 1 second before resuming after error
            } catch (err: any) {
              // If error handling itself fails, just log and continue
              // Use console.error for critical errors
              const errMsg = err && typeof err === 'object' && 'message' in err 
                ? String(err.message) 
                : String(err || "Unknown error")
              console.error("Error in scanner error callback:", err)
              try {
                addDebugLog(`❌ Error in error handler: ${errMsg}`)
              } catch {
                // If even addDebugLog fails, just use console
                console.error("Failed to add debug log:", errMsg)
              }
              setScanningStatus("Scanning...")
            }
          }
          )
        } catch (renderError: any) {
          // Catch any errors during scanner.render() initialization
          const renderErrMsg = renderError && typeof renderError === 'object' && 'message' in renderError
            ? String(renderError.message)
            : String(renderError || "Unknown render error")
          addDebugLog(`❌ Error during scanner.render(): ${renderErrMsg}`)
          console.error("Scanner render error:", renderError)
          setError(`Failed to start scanner: ${renderErrMsg}`)
          setScannerActive(false)
          setScanningStatus("")
          return
        }
        
        addDebugLog("✅ Scanner.render() called successfully")
        // Update status after initialization
        setScanningStatus("Ready - Position barcode in frame")
        addDebugLog("✅ Scanner initialization complete")
      } catch (err: any) {
        addDebugLog("❌ Error initializing scanner!")
        addDebugLog(`❌ Error message: ${err?.message || "Unknown error"}`)
        addDebugLog(`❌ Error name: ${err?.name || "Unknown"}`)
        if (err?.stack) {
          addDebugLog(`❌ Error stack: ${err.stack.substring(0, 200)}...`)
        }
        
        let errorMessage = "Failed to start camera. "
        
        if (err?.message?.includes("Permission denied") || err?.message?.includes("NotAllowedError")) {
          addDebugLog("❌ Permission denied error")
          errorMessage += "Please allow camera access in your browser settings."
        } else if (err?.message?.includes("NotFoundError") || err?.message?.includes("No camera")) {
          addDebugLog("❌ Camera not found error")
          errorMessage += "No camera found. Please connect a camera or use manual input."
        } else if (err?.message?.includes("NotReadableError")) {
          addDebugLog("❌ Camera not readable error")
          errorMessage += "Camera is already in use by another application."
        } else {
          addDebugLog("❌ Generic camera error")
          errorMessage += "Please check permissions and try again."
        }
        
        addDebugLog(`❌ Setting error message: ${errorMessage}`)
        setError(errorMessage)
        setScannerActive(false)
        setScanningStatus("")
        addDebugLog("❌ Error handling complete")
      }
    }, 100) // Small delay to ensure DOM is ready

    return () => {
      addDebugLog("🔍 useEffect cleanup function called")
      clearTimeout(timer)
      addDebugLog("🔍 Timer cleared")
      // Remove error handlers
      window.removeEventListener('error', handleGlobalError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      // Cleanup scanner if component unmounts or scannerActive changes
      if (scannerRef.current) {
        addDebugLog("🔍 Cleaning up scanner in useEffect cleanup")
        scannerRef.current.clear().catch((err) => {
          addDebugLog(`❌ Error in cleanup: ${err?.message || "Unknown"}`)
        })
        scannerRef.current = null
        addDebugLog("✅ Scanner cleaned up in useEffect")
      }
    }
  }, [scannerActive])

  // Cleanup scanner on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(() => {})
      }
    }
  }, [])
  
  // Add keyboard support for Escape key to clear product and Spacebar to list on eBay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only clear if:
      // 1. Escape key is pressed
      // 2. Product data exists
      // 3. Scanner is not active (to avoid conflicts)
      // 4. No aspect form is showing (to allow escape to close form first)
      if (e.key === "Escape" && productData && !scannerActive && !showAspectForm) {
        handleClearProduct()
      }
      
      // Handle aspect form keyboard shortcuts
      if (showAspectForm) {
        // Space to confirm/submit aspects
        if (e.key === " " && 
            !(e.target instanceof HTMLInputElement) &&
            !(e.target instanceof HTMLTextAreaElement) &&
            !(e.target instanceof HTMLSelectElement)) {
          e.preventDefault()
          handleSubmitAspects()
        }
        // Escape to cancel aspect form
        if (e.key === "Escape") {
          setShowAspectForm(false)
          setMissingAspects([])
          setUserProvidedAspects({})
        }
      }
      
      // List on eBay with spacebar:
      // 1. Spacebar is pressed
      // 2. Product data exists
      // 3. Not currently listing (to avoid duplicate listings)
      // 4. Scanner is not active
      // 5. No aspect form is showing
      // 6. Target is not an input, textarea, button, or select (to avoid conflicts when typing)
      if (
        e.key === " " && 
        productData && 
        !listingLoading && 
        !scannerActive && 
        !showAspectForm &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLButtonElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        e.preventDefault() // Prevent page scroll
        handleListOnEbay()
      }
    }
    
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [productData, scannerActive, showAspectForm, listingLoading])

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-6xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0 text-center">
            <div className="text-gray-600 dark:text-gray-400">Checking eBay connection...</div>
          </div>
        </div>
      </div>
    )
  }

  const shouldShowConnectScreen =
    !isConnected && !productData && !error && !listingError && !listingSuccess

  if (shouldShowConnectScreen) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-6xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">
              Product Search
            </h1>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-8 text-center">
              <svg
                className="mx-auto h-16 w-16 text-yellow-400 mb-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <h2 className="text-2xl font-bold text-yellow-800 dark:text-yellow-400 mb-4">
                eBay Account Not Connected
              </h2>
              <p className="text-yellow-700 dark:text-yellow-300 mb-6">
                You need to connect your eBay account via OAuth before you can search for products.
              </p>
              <Link
                to="/ebay-connect"
                className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors duration-200"
              >
                Connect eBay Account
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto py-3 sm:px-6 lg:px-8">
        <div className="px-4 py-3 sm:px-0">
          {/* Search Bar - Compact */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4 mb-4">
            <form onSubmit={handleSearch}>
              <div className="flex gap-3">
                <select
                  value={searchMediaType}
                  onChange={(e) => setSearchMediaType(e.target.value)}
                  aria-label="Media type"
                  className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="DVD">DVD</option>
                  <option value="CD">CD</option>
                  <option value="VHS">VHS</option>
                  <option value="Cassette">Cassette</option>
                  <option value="Other">Other</option>
                </select>
                <select
                  value={searchType}
                  onChange={(e) => setSearchType(e.target.value as SearchType)}
                  aria-label="Search type"
                  className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="upc">UPC</option>
                  <option value="title">Title</option>
                  <option value="any">Any value</option>
                </select>
                <input
                  ref={upcInputRef}
                  id="upc"
                  type="text"
                  value={upc}
                  onChange={(e) => setUpc(e.target.value)}
                  onKeyDown={(e) => {
                    // Spacebar quick-list shortcut: only in UPC mode, where the
                    // search value never contains spaces. In title/any mode the
                    // user needs to type spaces normally.
                    if (e.key === " " && searchType === "upc" && productData && !listingLoading && !scannerActive && !showAspectForm) {
                      e.preventDefault()
                      handleListOnEbay()
                    }
                  }}
                  placeholder={
                    searchType === "upc"
                      ? "Enter UPC Code (e.g., 885909950805)"
                      : searchType === "title"
                        ? "Enter product title"
                        : "Enter any search value"
                  }
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  required
                />
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold rounded-lg transition-colors duration-200"
                  >
                    {loading ? "Searching..." : "Search"}
                  </button>
                  <button
                    type="button"
                    onClick={scannerActive ? stopScanner : startScanner}
                    className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition-colors duration-200 flex items-center gap-2"
                  >
                    {scannerActive ? (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Stop Scanner
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                        </svg>
                        Scan Barcode
                      </>
                    )}
                  </button>
                </div>
            </form>

            {noMatchWarning && (
              <div className="mt-4 p-4 bg-amber-100 dark:bg-amber-900/30 border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-300 rounded">
                No exact UPC matches found on in-house catalog or eBay. Please fill out the boxes below or search again by title.
              </div>
            )}

            {error && (
              <div className="mt-4 p-4 bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-400 dark:border-yellow-700 text-yellow-700 dark:text-yellow-400 rounded">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="font-semibold mb-1">Error</p>
                    <p>{error}</p>
                  </div>
                  {(error.includes("reconnect") || error.includes("connect")) && (
                    <Link
                      to="/ebay-connect"
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors duration-200 whitespace-nowrap shrink-0"
                    >
                      Reconnect eBay
                    </Link>
                  )}
                </div>
              </div>
            )}

            {/* Floor Warning Dialog Modal */}
            {showFloorWarning && floorWarningData && (
              <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
                <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full shadow-xl">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex-shrink-0 w-12 h-12 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
                      <svg className="w-6 h-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                        Price Hit Floor - Reject Item?
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        This item's price is below the minimum threshold
                      </p>
                    </div>
                  </div>
                  
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-6">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">Original Price:</span>
                        <span className="font-medium text-gray-900 dark:text-white">${floorWarningData.original.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">After ${discountAmount.toFixed(2)} Discount:</span>
                        <span className="font-medium text-red-600 dark:text-red-400 line-through">${(floorWarningData.original - discountAmount).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">Minimum Floor:</span>
                        <span className="font-medium text-amber-600 dark:text-amber-400">${floorWarningData.floor.toFixed(2)}</span>
                      </div>
                      <hr className="border-amber-200 dark:border-amber-700" />
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">Final List Price:</span>
                        <span className="font-bold text-amber-600 dark:text-amber-400">${floorWarningData.discounted.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                  
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                    The discounted price (${(floorWarningData.original - discountAmount).toFixed(2)}) is below your minimum floor (${floorWarningData.floor.toFixed(2)}). 
                    <strong className="text-amber-700 dark:text-amber-300"> Consider rejecting this item</strong> or proceed with the floor price.
                  </p>
                  
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setShowFloorWarning(false)
                        setFloorWarningData(null)
                        // Clear the product to "reject" it
                        setProductData(null)
                        setUpc("")
                        setEditedTitle("")
                        setEditedDescription("")
                        setEditedCondition("")
                        setEditedPrice("")
                      }}
                      className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg transition-colors"
                    >
                      Reject Item
                    </button>
                    <button
                      onClick={() => {
                        setShowFloorWarning(false)
                        setFloorWarningData(null)
                        // Proceed with listing at floor price
                        handleListOnEbay(undefined, true)
                      }}
                      className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg transition-colors"
                    >
                      List at ${floorWarningData.discounted.toFixed(2)}
                    </button>
                  </div>
                  
                  <button
                    onClick={() => {
                      setShowFloorWarning(false)
                      setFloorWarningData(null)
                    }}
                    className="w-full mt-3 px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Barcode Scanner Modal */}
            {scannerActive && (
              <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
                <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-lg w-full max-h-[70vh] overflow-y-auto">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                      Scan Barcode
                    </h3>
                    <button
                      onClick={stopScanner}
                      className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                      aria-label="Close scanner"
                    >
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  
                  {/* Scanner Container */}
                  <div id={scannerElementId} className="w-full mb-4 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-900 max-h-[250px]"></div>
                  
                  {/* Scanning Status */}
                  {scanningStatus && (
                    <div className="mb-4 text-center">
                      <p className={`text-sm font-medium ${
                        scanningStatus.includes("Error") || scanningStatus.includes("error")
                          ? "text-red-600 dark:text-red-400"
                          : scanningStatus.includes("detected") && !scanningStatus.includes("Error")
                          ? "text-green-600 dark:text-green-400" 
                          : scanningStatus.includes("Initializing")
                          ? "text-blue-600 dark:text-blue-400"
                          : "text-gray-600 dark:text-gray-400"
                      }`}>
                        {scanningStatus}
                      </p>
                    </div>
                  )}
                  
                  {/* Scanning Tips */}
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
                    <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-2 flex items-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Tips for Better Scanning
                    </h4>
                    <ul className="text-xs text-blue-800 dark:text-blue-300 space-y-1 list-disc list-inside">
                      <li>Hold the barcode steady and parallel to the screen</li>
                      <li>Ensure good lighting (avoid glare and shadows)</li>
                      <li>Keep the barcode within the scanning frame</li>
                      <li>Hold the device 4-6 inches away from the barcode</li>
                      <li>Make sure the barcode is clear and not damaged</li>
                    </ul>
                  </div>
                  
                  <p className="text-sm text-gray-600 dark:text-gray-400 text-center mb-4">
                    Position the barcode horizontally within the frame
                  </p>
                </div>
              </div>
            )}
          </div>
          
          {/* Show product details */}
          {productData && (
            <>
              {/* Three boxes in one row: Duplicate Notice + Previous SKU + SKU Preview */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
                {/* Duplicate Notice / No Duplicates Box */}
                <div className="flex-1">
                  {checkingDuplicates ? (
                    <div className="h-full p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded-lg flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <p className="text-sm text-blue-700 dark:text-blue-300">Checking duplicates...</p>
                    </div>
                  ) : hasDuplicates && duplicateSku ? (
                    <div className="h-full p-3 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded-lg">
                      <h3 className="text-sm font-bold text-red-700 dark:text-red-400 mb-1">Duplicate Notice</h3>
                      <div className="bg-white dark:bg-gray-800 p-2 rounded border border-red-200 dark:border-red-800 mb-2">
                        <p className="text-xs text-gray-500 dark:text-gray-400">Existing Listing SKU:</p>
                        <p className="text-lg font-bold text-red-700 dark:text-red-400 font-mono">{duplicateSku}</p>
                      </div>
                      <p className="text-xs text-red-600 dark:text-red-300 mb-2">
                        <span className="font-semibold">UPC:</span> <span className="font-mono">{duplicateUpc || upc}</span> - This product is already listed in your eBay inventory.
                      </p>
                      {inventoryMessage && (
                        <div className={`mb-2 p-2 rounded text-xs ${
                          inventoryMessage.type === "success"
                            ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300"
                            : "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
                        }`}>
                          {inventoryMessage.text}
                        </div>
                      )}
                      <button
                        onClick={handleIncreaseInventory}
                        disabled={increasingInventory}
                        className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        {increasingInventory ? (
                          <>
                            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span>Increasing...</span>
                          </>
                        ) : (
                          <span>Increase existing product inventory by 1</span>
                        )}
                      </button>
                    </div>
                  ) : duplicateCheckComplete ? (
                    <div className="h-full p-3 bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-700 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <svg className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <h3 className="text-sm font-bold text-green-700 dark:text-green-400">No Duplicates Found</h3>
                      </div>
                      <p className="text-xs text-green-600 dark:text-green-300">
                        <span className="font-semibold">UPC:</span> <span className="font-mono">{upc}</span> - This product is not in your eBay inventory. You can proceed to list it.
                      </p>
                    </div>
                  ) : (
                    <div className="h-full p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg flex items-center justify-center">
                      <p className="text-sm text-gray-500 dark:text-gray-400">Duplicate status pending...</p>
                    </div>
                  )}
                </div>

                {/* Previous SKU Box */}
                <div className="p-3 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border border-green-300 dark:border-green-700 rounded-lg">
                  <h3 className="text-xs font-medium text-green-900 dark:text-green-300 mb-1">Previous SKU Number</h3>
                  <p className="text-xl font-bold text-green-700 dark:text-green-400 font-mono">
                    {listedSku || "—"}
                  </p>
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                    {listedSku ? "This SKU was assigned to your last listed product" : "No previous listing"}
                  </p>
                </div>

                {/* SKU Preview Box */}
                <div className="p-3 bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 border border-purple-200 dark:border-purple-700 rounded-lg">
                  <h3 className="text-xs font-medium text-purple-900 dark:text-purple-300 mb-1">SKU Preview</h3>
                  {loadingSku ? (
                    <p className="text-sm text-purple-600 dark:text-purple-400">Loading...</p>
                  ) : (
                    <p className="text-xl font-bold text-purple-700 dark:text-purple-400 font-mono">
                      {skuPreview || "—"}
                    </p>
                  )}
                  <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                    This SKU will be assigned when you list this product
                  </p>
                </div>
              </div>

              {/* Main Product Content - Two Column Layout */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
              <div className="p-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Product Image */}
                  {productData.image?.imageUrl && (
                    <div className="relative">
                      <img
                        src={productData.image.imageUrl}
                        alt={productData.title || "Product"}
                        className="w-full h-auto max-h-[320px] object-contain rounded-lg shadow bg-gray-100 dark:bg-gray-900"
                        data-image-source={productData._imageSources?.source || "unknown"}
                        data-stock-image-url={productData._imageSources?.stockImage?.imageUrl || ""}
                        data-seller-image-url={productData._imageSources?.sellerImage?.imageUrl || ""}
                        title={`Image Source: ${productData._imageSources?.source === "stock_preferred_with_seller_fallback" ? "Stock Image (from eBay Catalog)" : productData._imageSources?.source === "seller_only" ? "Seller Image (from Browse API)" : productData._imageSources?.source === "seller_only_fallback_due_to_size" ? "Seller Image (fallback - stock image too small)" : "Unknown"}`}
                      />
                      {/* Image Source Badge */}
                      {productData._imageSources?.source && (
                        <div className={`absolute top-2 right-2 px-2 py-1 rounded text-xs font-semibold ${
                          productData._imageSources.source === "stock_preferred_with_seller_fallback"
                            ? "bg-green-500 text-white"
                            : productData._imageSources.source === "seller_only" || productData._imageSources.source === "seller_only_fallback_due_to_size"
                            ? "bg-blue-500 text-white"
                            : "bg-gray-500 text-white"
                        }`}>
                          {productData._imageSources.source === "stock_preferred_with_seller_fallback"
                            ? "📦 Stock"
                            : productData._imageSources.source === "seller_only"
                            ? "👤 Seller"
                            : productData._imageSources.source === "seller_only_fallback_due_to_size"
                            ? "👤 Seller (Fallback)"
                            : "❓ Unknown"}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Product Details */}
                  <div className="space-y-3">
                    {/* Edit button - Only show when default edit mode is disabled */}
                    {!defaultEditMode && (
                      <div className="flex justify-end gap-2">
                        {!isEditing && (
                          <button
                            onClick={() => {
                              // Ensure condition defaults to "Used - Very Good" if empty
                              if (!editedCondition || editedCondition.trim() === "") {
                                setEditedCondition("Used - Very Good")
                              }
                              // When entering edit mode, initialize editedDescription
                              // If override is enabled and there's a previously saved description, use it
                              // Otherwise, use product data description or empty if override is enabled
                              console.log("[FRONTEND DEBUG] ========== EDIT CLICKED ==========")
                              console.log("[FRONTEND DEBUG] Edit Clicked - Current state:", JSON.stringify({
                                useOverrideDescription: useOverrideDescription,
                                productDataDescription: productData.description,
                                productDataShortDescription: productData.shortDescription,
                                currentEditedDescription: editedDescription
                              }, null, 2))
                              
                              if (useOverrideDescription) {
                                // Check if there's a previously saved description in productData
                                const savedDescription = productData.description || productData.shortDescription || ""
                                console.log("[FRONTEND DEBUG] Override enabled - Loading saved description:", JSON.stringify({
                                  savedDescription: savedDescription,
                                  savedDescriptionLength: savedDescription.length,
                                  source: productData.description ? "productData.description" : (productData.shortDescription ? "productData.shortDescription" : "empty")
                                }, null, 2))
                                setEditedDescription(savedDescription)
                              } else {
                                const normalDescription = productData.shortDescription || productData.description || ""
                                console.log("[FRONTEND DEBUG] Override disabled - Loading normal description:", normalDescription)
                                setEditedDescription(normalDescription)
                              }
                              setIsEditing(true)
                              console.log("[FRONTEND DEBUG] Edit mode enabled")
                            }}
                            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white font-semibold rounded-lg transition-colors duration-200 flex items-center gap-2"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            Edit
                          </button>
                        )}
                      </div>
                    )}

                    {/* Title - Editable */}
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Title</h3>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editedTitle}
                          onChange={(e) => setEditedTitle(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          placeholder="e.g. The Matrix (1999)"
                        />
                      ) : (
                        <p className="text-gray-900 dark:text-white">
                          {(() => {
                            console.log("[Title Display] productData.title:", productData.title)
                            console.log("[Title Display] bannedKeywords:", bannedKeywords)
                            console.log("[Title Display] keywordsLoaded:", keywordsLoaded)
                            const result = productData.title ? removeKeywords(productData.title, bannedKeywords) : "No title"
                            console.log("[Title Display] Result after removeKeywords:", result)
                            return result
                          })()}
                        </p>
                      )}
                    </div>

                    {/* Description - Editable */}
                    {/* When universal override is enabled and has content, show it. Otherwise show normal description */}
                    {useOverrideDescription && universalOverrideDescription && universalOverrideDescription.trim().length > 0 ? (
                      // Universal Override Description mode: show the universal description from settings
                      <div>
                        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                          Description
                          <span className="ml-2 text-xs font-normal text-green-600 dark:text-green-400">
                            (Universal Override Applied)
                          </span>
                        </h3>
                        <div className="p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                          <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap">
                            {universalOverrideDescription}
                          </p>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          This description is set in Settings and applies to all listings automatically.
                        </p>
                      </div>
                    ) : (
                      // Normal Description mode: show in both view and edit mode
                      <div>
                        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</h3>
                        {isEditing ? (
                          <textarea
                            value={editedDescription}
                            onChange={(e) => setEditedDescription(e.target.value)}
                            rows={2}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                            placeholder="e.g. A young soldier becomes separated from his unit during a riot in Belfast..."
                          />
                        ) : (
                          <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap">
                            {productData.shortDescription || productData.description || "No description"}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Media Details - structured fields combined into the listing description */}
                    <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
                      <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Product Details</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {/* Type: drop-down -> sets the eBay category. Selecting DVD
                            runs the catalog check and populates from it. */}
                        <select
                          value={MediaType}
                          onChange={(e) => handleMediaTypeChange(e.target.value)}
                          aria-label="Type"
                          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                        >
                          <option value="">Type…</option>
                          <option value="DVD">DVD</option>
                          <option value="CD">CD</option>
                          <option value="VHS">VHS</option>
                          <option value="Cassette">Cassette</option>
                          <option value="Other">Other</option>
                        </select>
                        {([
                          ["Year", MediaYear, setMediaYear, "e.g. 2015"],
                          ["Publisher", MediaPublisher, setMediaPublisher, "e.g. Sony Pictures"],
                          ["Genre", MediaGenre, setMediaGenre, "e.g. Action, Suspense"],
                          ["Rated", MediaRated, setMediaRated, "e.g. R"],
                          ["Length", MediaLength, setMediaLength, "e.g. 01:39"],
                        ] as [string, string, (v: string) => void, string][]).map(
                          ([label, val, setter, example]) => (
                            <input
                              key={label}
                              type="text"
                              value={val}
                              onChange={(e) => setter(e.target.value)}
                              placeholder={example}
                              aria-label={label}
                              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                            />
                          )
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                        Type sets the eBay category. Selecting "DVD" checks the in-house catalog and, on listing, saves these details to it. The fields combine with the description into the listing.
                      </p>
                    </div>

                    {/* Manual photo upload */}
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Listing Photo</h3>
                      <div className="flex items-center gap-3">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handlePhotoUpload}
                          disabled={uploadingPhoto}
                          className="text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white file:cursor-pointer hover:file:bg-blue-700 disabled:opacity-50"
                        />
                        {uploadingPhoto && (
                          <span className="text-sm text-gray-500 dark:text-gray-400">Uploading…</span>
                        )}
                      </div>
                    </div>

                    {/* Price - Editable */}
                    {productData.price && (() => {
                      const currentPrice = isEditing ? parseFloat(editedPrice) || 0 : parseFloat(productData.price.value || "0") || 0
                      const priceInfo = calculateDiscountedPrice(currentPrice)
                      const currency = productData.price.currency || "USD"
                      
                      return (
                        <div>
                          <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            Price
                            {isMeanPrice && (
                              <span className="ml-2 text-xs text-blue-600 dark:text-blue-400 font-normal">
                                (mean price of latest 10 listings)
                              </span>
                            )}
                          </h3>
                          {isEditing ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-gray-600 dark:text-gray-400 text-sm">{currency}</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={editedPrice}
                                  onChange={(e) => setEditedPrice(e.target.value)}
                                  className="w-28 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-lg font-bold"
                                  placeholder="0.00"
                                />
                                {currentPrice > 0 && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-gray-400">→</span>
                                    <span className={`text-lg font-bold ${priceInfo.hitFloor ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                                      {currency} {priceInfo.discounted.toFixed(2)}
                                    </span>
                                    <span className="text-xs text-red-600 dark:text-red-400">
                                      (-${discountAmount.toFixed(2)})
                                    </span>
                                  </div>
                                )}
                              </div>
                              {/* Floor Warning in Edit Mode */}
                              {priceInfo.hitFloor && currentPrice > 0 && (
                                <div className="flex items-center gap-2 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                                  <svg className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                  </svg>
                                  <span className="text-sm text-amber-700 dark:text-amber-300">
                                    <strong>Price hit floor!</strong> Would be ${priceInfo.rawDiscounted.toFixed(2)}, using minimum ${minimumPrice.toFixed(2)}. Consider rejecting.
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                {priceInfo.original > priceInfo.discounted && (
                                  <span className="text-sm text-gray-500 dark:text-gray-400 line-through">
                                    {currency} {priceInfo.original.toFixed(2)}
                                  </span>
                                )}
                                <span className={`text-xl font-bold ${priceInfo.hitFloor ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                                  {currency} {priceInfo.discounted.toFixed(2)}
                                </span>
                                {priceInfo.original > priceInfo.discounted && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300">
                                    Save {currency} {priceInfo.actualDiscount.toFixed(2)}
                                  </span>
                                )}
                              </div>
                              {/* Floor Warning in View Mode */}
                              {priceInfo.hitFloor && (
                                <div className="flex items-center gap-2 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                                  <svg className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                  </svg>
                                  <span className="text-sm text-amber-700 dark:text-amber-300">
                                    <strong>Price hit floor!</strong> Consider rejecting this item.
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Condition - Editable */}
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Condition</h3>
                      {isEditing ? (
                        <div>
                          <select
                            value={editedCondition}
                            onChange={(e) => setEditedCondition(e.target.value)}
                            className="w-full px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                          >
                            {conditions.map((condition) => (
                              <option key={condition} value={condition}>
                                {condition}
                              </option>
                            ))}
                          </select>
                          {editedCondition && getConditionDescription(editedCondition) && (
                            <p className="mt-1 text-xs text-blue-600 dark:text-blue-400 italic">
                              {getConditionDescription(editedCondition)}
                            </p>
                          )}
                        </div>
                      ) : (
                        <div>
                          <p className="text-gray-900 dark:text-white font-semibold">
                            {productData.condition || editedCondition || "Used - Very Good"}
                          </p>
                          {(productData.condition || editedCondition || "Used - Very Good") && getConditionDescription(productData.condition || editedCondition || "Used - Very Good") && (
                            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400 italic">
                              {getConditionDescription(productData.condition || editedCondition || "Used - Very Good")}
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-wrap gap-2 mt-2">
                      {/* List on eBay Button */}
                      <button
                        onClick={() => handleListOnEbay()}
                        disabled={listingLoading}
                        className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors duration-200 flex items-center justify-center gap-2 text-sm"
                      >
                        {listingLoading ? (
                          <>
                            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Listing...
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            List on eBay
                          </>
                        )}
                      </button>
                      
                      {/* View on eBay Button */}
                      {productData.itemWebUrl && (
                        <a
                          href={productData.itemWebUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors duration-200 text-center text-sm"
                        >
                          View on eBay
                        </a>
                      )}
                      
                      {/* View Listing Button (if successfully listed) */}
                      {listingSuccess && listingSuccess.startsWith("http") && (
                        <a
                          href={listingSuccess}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg transition-colors duration-200 text-center text-sm"
                        >
                          View Listing
                        </a>
                      )}
                    </div>
                    
                    {/* Listing Success Message */}
                    {listingSuccess && (
                      <div className="mt-2 p-2 bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-700 text-green-700 dark:text-green-400 rounded-lg">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="font-semibold text-sm">Success!</span>
                          {listedSku && (
                            <span className="font-mono text-sm font-semibold">{listedSku}</span>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {/* Missing Item Specifics Form */}
                    {showAspectForm && missingAspects.length > 0 && (
                      <div className="mt-4 p-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-400 dark:border-yellow-700 rounded-lg">
                        <div className="flex items-start gap-2 mb-4">
                          <svg className="w-5 h-5 mt-0.5 shrink-0 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                          <div className="flex-1">
                            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Please fill in the following item specifics</h3>
                            <div className="space-y-4">
                              {missingAspects.map((aspect) => {
                                const aspectDef = aspectDefinitions.find((a: any) => a.name === aspect)
                                const hasPredefinedValues = aspectDef && aspectDef.values && aspectDef.values.length > 0
                                
                                return (
                                  <div key={aspect} className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                      {aspect} <span className="text-red-500">*</span>
                                    </label>
                                    {hasPredefinedValues ? (
                                      <select
                                        value={userProvidedAspects[aspect] || ""}
                                        onChange={(e) => setUserProvidedAspects({ ...userProvidedAspects, [aspect]: e.target.value })}
                                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                        required
                                      >
                                        <option value="">Select {aspect}</option>
                                        {aspectDef.values.map((value: string) => (
                                          <option key={value} value={value}>{value}</option>
                                        ))}
                                      </select>
                                    ) : (
                                      <input
                                        type="text"
                                        value={userProvidedAspects[aspect] || ""}
                                        onChange={(e) => setUserProvidedAspects({ ...userProvidedAspects, [aspect]: e.target.value })}
                                        placeholder={`Enter ${aspect}`}
                                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                        required
                                      />
                                    )}
                                  </div>
                                )
                              })}
                            </div>                        
                            
                            <div className="flex gap-3 mt-6">
                              <button
                                onClick={handleSubmitAspects}
                                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition-colors duration-200"
                              >
                                Continue Listing
                              </button>
                              <button
                                onClick={() => {
                                  setShowAspectForm(false)
                                  setMissingAspects([])
                                  setUserProvidedAspects({})
                                }}
                                className="px-6 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-white font-semibold rounded-lg transition-colors duration-200"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Listing Error Message */}
                    {listingError && !showAspectForm && (
                      <div className="mt-2 p-2 bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-400 rounded-lg">
                        <div className="flex items-start gap-2">
                          <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          <div className="flex-1 text-sm">
                            <p className="font-semibold">Error</p>
                            <p className="mb-2">{listingError}</p>
                            {(listingError.includes("2004") || listingError.includes("sell.inventory") || listingError.includes("reconnect")) && (
                              <Link
                                to="/ebay-connect"
                                className="inline-block px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors duration-200 text-xs"
                              >
                                Go to eBay Connect Page →
                              </Link>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

              {/* Footer: Seller Note + Keyboard Shortcuts */}
              <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg">
                <div className="flex flex-col lg:flex-row lg:items-start gap-3">
                  {/* Seller Note */}
                  <div className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400 flex-1 min-w-0">
                    <svg className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>
                      <span className="font-medium">Seller Note:</span>{" "}
                      {enableSellerNoteEditing ? universalSellerNoteText : DEFAULT_SELLER_NOTE}
                    </span>
                  </div>
                  
                  {/* Keyboard Shortcuts */}
                  <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 shrink-0 lg:self-center">
                    <svg className="w-3 h-3 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                    </svg>
                    <kbd className="px-1.5 py-0.5 text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 rounded dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600">Space</kbd>
                    <span>to confirm</span>
                    <kbd className="px-1.5 py-0.5 text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 rounded dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600">Esc</kbd>
                    <span>to cancel</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {!productData && !error && (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6 text-center">
              <svg
                className="mx-auto h-12 w-12 text-blue-400"
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
              <p className="mt-4 text-gray-600 dark:text-gray-400">
                Enter a UPC code to search for products on eBay
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

