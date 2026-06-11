import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import {
  readErrorBody,
  getEbayBaseUrl,
  getValidEbayToken,
  ebayHeaders,
  debugLog,
} from "@/lib/ebay"

export async function POST(req: Request) {
  debugLog("[LIST API DEBUG] ========== LISTING REQUEST STARTED ==========")
  try {
    const logOfferState = async (
      baseUrl: string,
      accessToken: string,
      offerId: string,
      label: string
    ) => {
      try {
        const offerDetailsUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}`
        const offerDetailsResponse = await fetch(offerDetailsUrl, {
          method: "GET",
          headers: ebayHeaders(accessToken),
        })

        if (!offerDetailsResponse.ok) {
          const { errorData: detailsError } = await readErrorBody(offerDetailsResponse)
          console.warn(`[LIST API DEBUG] Offer state check failed (${label}):`, {
            offerId,
            status: offerDetailsResponse.status,
            statusText: offerDetailsResponse.statusText,
            detailsError,
          })
          return null
        }

        const offerDetails = await offerDetailsResponse.json()
        debugLog(`[LIST API DEBUG] Offer state check (${label}):`, {
          offerId,
          bestOfferTerms: offerDetails?.bestOfferTerms || null,
          pricingSummary: offerDetails?.pricingSummary || null,
          marketplaceId: offerDetails?.marketplaceId || null,
          categoryId: offerDetails?.categoryId || null,
          listingPolicies: offerDetails?.listingPolicies || null,
        })
        return offerDetails
      } catch (offerStateError) {
        console.warn(`[LIST API DEBUG] Offer state check exception (${label}):`, {
          offerId,
          error:
            offerStateError instanceof Error
              ? offerStateError.message
              : String(offerStateError),
        })
        return null
      }
    }

    const hasBestOfferEnabled = (offerDetails: any): boolean => {
      return !!offerDetails?.bestOfferTerms?.bestOfferEnabled
    }

    const tryEnsureBestOfferTerms = async (
      baseUrl: string,
      accessToken: string,
      offerId: string,
      offerPayload: any
    ) => {
      const beforeFix = await logOfferState(
        baseUrl,
        accessToken,
        offerId,
        "BEST_OFFER_ENSURE_BEFORE_RETRY"
      )

      if (hasBestOfferEnabled(beforeFix)) {
        return { ensured: true, attempted: false }
      }

      console.warn("[LIST API DEBUG] Best Offer not persisted; retrying offer update", {
        offerId,
      })

      const retryUpdateUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}`
      const retryUpdateResponse = await fetch(retryUpdateUrl, {
        method: "PUT",
        headers: ebayHeaders(accessToken),
        body: JSON.stringify(offerPayload),
      })

      if (!retryUpdateResponse.ok) {
        const { errorData: retryError } = await readErrorBody(retryUpdateResponse)
        console.warn("[LIST API DEBUG] Best Offer retry update failed:", {
          offerId,
          status: retryUpdateResponse.status,
          statusText: retryUpdateResponse.statusText,
          retryError,
        })
        return { ensured: false, attempted: true }
      }

      const afterFix = await logOfferState(
        baseUrl,
        accessToken,
        offerId,
        "BEST_OFFER_ENSURE_AFTER_RETRY"
      )
      return { ensured: hasBestOfferEnabled(afterFix), attempted: true }
    }

    const recreateOfferWithBestOffer = async (
      baseUrl: string,
      accessToken: string,
      existingOfferId: string,
      offerPayload: any
    ) => {
      console.warn("[LIST API DEBUG] Starting strong Best Offer fallback (recreate offer)", {
        existingOfferId,
      })

      // Withdraw the existing published offer before deletion. If the
      // withdraw fails, abort the recreate entirely rather than risk deleting
      // a live listing we could not cleanly take down.
      try {
        const withdrawUrl = `${baseUrl}/sell/inventory/v1/offer/${existingOfferId}/withdraw`
        const withdrawResponse = await fetch(withdrawUrl, {
          method: "POST",
          headers: ebayHeaders(accessToken),
          body: JSON.stringify({ reason: "OTHER" }),
        })
        if (!withdrawResponse.ok) {
          const { errorData: withdrawError } = await readErrorBody(withdrawResponse)
          console.warn("[LIST API DEBUG] Withdraw existing offer failed; aborting recreate:", {
            existingOfferId,
            status: withdrawResponse.status,
            statusText: withdrawResponse.statusText,
            withdrawError,
          })
          return { recreated: false, ensured: false }
        }
        debugLog("[LIST API DEBUG] Existing offer withdrawn before recreate:", {
          existingOfferId,
        })
      } catch (withdrawError) {
        console.warn("[LIST API DEBUG] Withdraw existing offer exception; aborting recreate:", {
          existingOfferId,
          error: withdrawError instanceof Error ? withdrawError.message : String(withdrawError),
        })
        return { recreated: false, ensured: false }
      }

      const deleteUrl = `${baseUrl}/sell/inventory/v1/offer/${existingOfferId}`
      const deleteResponse = await fetch(deleteUrl, {
        method: "DELETE",
        headers: ebayHeaders(accessToken),
      })

      if (!deleteResponse.ok) {
        const { errorData: deleteError } = await readErrorBody(deleteResponse)
        console.warn("[LIST API DEBUG] Delete existing offer failed:", {
          existingOfferId,
          status: deleteResponse.status,
          statusText: deleteResponse.statusText,
          deleteError,
        })
        return { recreated: false, ensured: false }
      }

      debugLog("[LIST API DEBUG] Existing offer deleted successfully:", { existingOfferId })

      const createUrl = `${baseUrl}/sell/inventory/v1/offer`
      const createResponse = await fetch(createUrl, {
        method: "POST",
        headers: ebayHeaders(accessToken),
        body: JSON.stringify(offerPayload),
      })

      if (!createResponse.ok) {
        const { errorData: createError } = await readErrorBody(createResponse)
        console.warn("[LIST API DEBUG] Recreate offer POST failed:", {
          status: createResponse.status,
          statusText: createResponse.statusText,
          createError,
        })
        return { recreated: false, ensured: false }
      }

      const createdOfferData = await createResponse.json().catch(() => ({}))
      const recreatedOfferId = createdOfferData?.offerId
      if (!recreatedOfferId) {
        console.warn("[LIST API DEBUG] Recreate offer succeeded but offerId missing")
        return { recreated: false, ensured: false }
      }

      const publishUrl = `${baseUrl}/sell/inventory/v1/offer/${recreatedOfferId}/publish`
      const publishResponse = await fetch(publishUrl, {
        method: "POST",
        headers: ebayHeaders(accessToken),
      })

      if (!publishResponse.ok) {
        const { errorData: publishError } = await readErrorBody(publishResponse)
        console.warn("[LIST API DEBUG] Recreated offer publish failed:", {
          recreatedOfferId,
          status: publishResponse.status,
          statusText: publishResponse.statusText,
          publishError,
        })
        return { recreated: true, ensured: false, recreatedOfferId }
      }

      const recreatedPublishData = await publishResponse.json().catch(() => ({}))
      const recreatedState = await logOfferState(
        baseUrl,
        accessToken,
        recreatedOfferId,
        "BEST_OFFER_RECREATE_AFTER_PUBLISH"
      )

      return {
        recreated: true,
        ensured: hasBestOfferEnabled(recreatedState),
        recreatedOfferId,
        recreatedListingId: recreatedPublishData?.listingId,
      }
    }

    // Check if user is authenticated
    const session = await auth()
    
    if (!session) {
      debugLog("[LIST API DEBUG] ERROR: Unauthorized - no session")
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }
    
    debugLog("[LIST API DEBUG] User authenticated:", session.user.id)

    let body
    try {
      body = await req.json()
      debugLog("[LIST API DEBUG] Request body parsed successfully")
    } catch (parseError) {
      debugLog("[LIST API DEBUG] ERROR: Failed to parse JSON:", parseError)
      return NextResponse.json(
        { error: "Invalid request body. Could not parse JSON." },
        { status: 400 }
      )
    }

    let { 
      title, 
      description, 
      price, 
      condition, 
      conditionDescription,
      imageUrl, 
      categoryId, 
      upc, 
      ean, 
      isbn, 
      mpn, 
      brand, 
      aspects,
      // Additional fields from Browse API
      epid,  // eBay Product ID for better catalog matching
      additionalImages,  // Array of additional image URLs
      itemWebUrl,  // Original eBay listing URL (for reference)
      categories,  // Category information from Browse API
      conditionId,  // Condition ID from Browse API
      shortDescription  // Short description from Browse API (may contain Platform info)
    } = body

    // DEBUG: Log incoming description
    debugLog("[LIST API DEBUG] ========== LISTING REQUEST RECEIVED ==========")
    debugLog("[LIST API DEBUG] Incoming description:", {
      description: description,
      descriptionType: typeof description,
      descriptionLength: description ? description.length : 0,
      isEmpty: !description || (typeof description === 'string' && description.trim().length === 0),
      shortDescription: shortDescription,
      descriptionPreview: description ? description.substring(0, 100) : "null/undefined"
    })
    debugLog("[LIST API DEBUG] Incoming conditionDescription:", {
      conditionDescriptionType: typeof conditionDescription,
      hasConditionDescription: conditionDescription !== undefined,
      conditionDescriptionLength: typeof conditionDescription === "string" ? conditionDescription.length : 0,
      conditionDescriptionPreview:
        typeof conditionDescription === "string"
          ? conditionDescription.substring(0, 120)
          : "not_provided",
    })

    // Validate and sanitize required fields
    const missingFields: string[] = []
    
    // Title validation
    if (!title || (typeof title === 'string' && title.trim().length === 0)) {
      missingFields.push("title")
    } else {
      title = title.trim()
    }
    
    // Description - provide default if empty (but preserve empty string if explicitly sent)
    debugLog("[LIST API DEBUG] Processing description - before:", {
      description: description,
      isEmpty: !description || (typeof description === 'string' && description.trim().length === 0),
      isExplicitlyEmpty: description === ""
    })
    
    // Only set default if description is null/undefined, not if it's explicitly empty string
    // This allows override description to be intentionally empty
    if (description === null || description === undefined) {
      description = "No description provided." // Provide a default description
      debugLog("[LIST API DEBUG] Description was null/undefined, set to default:", description)
    } else if (typeof description === 'string' && description.trim().length === 0) {
      // If it's an empty string, check if we should use default or keep it empty
      // For now, we'll use default to ensure eBay listings have descriptions
      description = "No description provided."
      debugLog("[LIST API DEBUG] Description was empty string, set to default:", description)
    } else {
      description = description.trim()
      debugLog("[LIST API DEBUG] Description trimmed:", {
        originalLength: body.description?.length,
        trimmedLength: description.length,
        preview: description.substring(0, 100)
      })
    }
    
    // Seller note text (will be used in conditionDescription field, not in description)
    const defaultSellerNote =
      "Please note: any mention of a digital copy or code may be expired and/or unavailable. This does not affect the quality or functionality of the DVD."

    // Load user settings in parallel - these reads are independent
    const [sellerNoteSettings, offerSettings, savedPolicies] = await Promise.all([
      prisma.sellerNoteSettings.findUnique({ where: { userId: session.user.id } }),
      prisma.offerSettings.findUnique({ where: { userId: session.user.id } }),
      prisma.ebayBusinessPolicies.findUnique({ where: { userId: session.user.id } }),
    ])

    let sellerNote = defaultSellerNote
    let sellerNoteSource = "DEFAULT_HARDCODED"
    if (sellerNoteSettings?.enableSellerNoteEditing) {
      const universalSellerNote = (sellerNoteSettings.sellerNoteText || "").trim()
      sellerNote = universalSellerNote.length > 0 ? universalSellerNote : defaultSellerNote
      sellerNoteSource = universalSellerNote.length > 0 ? "UNIVERSAL_SETTING" : "DEFAULT_HARDCODED_EMPTY_UNIVERSAL"
    } else if (conditionDescription !== undefined) {
      if (typeof conditionDescription !== "string") {
        return NextResponse.json(
          { error: "conditionDescription must be a string" },
          { status: 400 }
        )
      }

      const trimmed = conditionDescription.trim()
      sellerNote = trimmed.length > 0 ? trimmed : defaultSellerNote
      sellerNoteSource = trimmed.length > 0 ? "REQUEST_CONDITION_DESCRIPTION" : "DEFAULT_HARDCODED_EMPTY_REQUEST"
    }
    debugLog("[LIST API DEBUG] Final Seller Note Decision:", {
      sellerNoteSource,
      sellerNoteLength: sellerNote.length,
      sellerNotePreview: sellerNote.substring(0, 120),
    })
    
    // Price validation
    const priceNum = parseFloat(price)
    if (!price || isNaN(priceNum) || priceNum <= 0) {
      missingFields.push("price (must be a valid number greater than 0)")
    }
    
    // Condition validation
    if (!condition || (typeof condition === 'string' && condition.trim().length === 0)) {
      missingFields.push("condition")
    } else {
      condition = condition.trim()
    }
    
    // Image validation - eBay requires at least one image
    const hasImage = (imageUrl && imageUrl.trim().length > 0) || 
                     (additionalImages && Array.isArray(additionalImages) && additionalImages.length > 0)
    if (!hasImage) {
      missingFields.push("image (at least one product image is required)")
    }

    if (missingFields.length > 0) {
      debugLog("[LIST API DEBUG] ERROR: Missing required fields:", missingFields)
      debugLog("[LIST API DEBUG] Received data:", {
        title: title || null,
        description: description || null,
        descriptionLength: description ? description.length : 0,
        price,
        condition: condition || null,
        hasImage
      })
      return NextResponse.json(
        { 
          error: `Missing or invalid required fields: ${missingFields.join(", ")}`,
          received: { 
            title: title || null, 
            description: description || null, 
            price, 
            condition: condition || null,
            hasImage
          }
        },
        { status: 400 }
      )
    }

    // Get a valid eBay access token (refreshes automatically if expired)
    const tokenResult = await getValidEbayToken(session.user.id)
    if (!tokenResult.ok) {
      return NextResponse.json(
        {
          error: tokenResult.error,
          needsReconnect: tokenResult.needsReconnect,
          details: tokenResult.details,
        },
        { status: tokenResult.status }
      )
    }
    const accessToken = tokenResult.accessToken

    const baseUrl = getEbayBaseUrl()

    // Atomically claim the next SKU counter value. The upsert increments the
    // stored counter in a single statement, so concurrent listing requests can
    // never claim the same counter (the old read-then-increment-after-success
    // flow could). A failed listing leaves a gap in the sequence, which is
    // harmless.
    let prefix = "SKU"
    let counter = 1
    try {
      const claimedSettings = await prisma.skuSettings.upsert({
        where: { userId: session.user.id },
        create: { userId: session.user.id, nextSkuCounter: 2, skuPrefix: null },
        update: { nextSkuCounter: { increment: 1 } },
      })
      // upsert returns the post-increment value (or 2 on first creation), so
      // the counter this request claimed is one less.
      counter = claimedSettings.nextSkuCounter - 1
      prefix = claimedSettings.skuPrefix || "SKU"
    } catch (error) {
      console.warn("SKU settings not available, using default:", error)
    }

    // Generate SKU using user's settings: {Prefix}-0000{counter}
    // Client requirement: "0000" (4 zeros) is literally prepended to the counter
    // Format: DVD-00001, DVD-000010, DVD-0000100, etc.
    const sku = `${prefix}-0000${counter}`

    debugLog("Generated SKU:", sku, `(Counter: ${counter}, Format: ${prefix}-0000X)`)

    // Step 1: Create an inventory item
    // Build product object - eBay requires at minimum a title
    const productObj: any = {
      title: title.substring(0, 80), // eBay title limit is 80 characters
    }
    
    // Add eBay Product ID (ePID) for better catalog matching - highest priority
    if (epid && epid.trim().length > 0) {
      productObj.epid = epid.trim()
      debugLog("Using eBay Product ID (ePID) for catalog matching:", epid)
    }
    
    // Add description if provided
    debugLog("[LIST API DEBUG] Adding description to productObj:", {
      hasDescription: !!(description && description.trim().length > 0),
      descriptionValue: description,
      isNoDescription: description === "No description",
      willAdd: description && description.trim().length > 0 && description !== "No description"
    })
    if (description && description.trim().length > 0 && description !== "No description") {
      productObj.description = description.substring(0, 50000)
      debugLog("[LIST API DEBUG] Added description to productObj:", {
        length: productObj.description.length,
        preview: productObj.description.substring(0, 100)
      })
    } else {
      debugLog("[LIST API DEBUG] NOT adding description to productObj (empty or 'No description')")
    }
    
    // Add images if provided - eBay expects imageUrls array
    const allImages: string[] = []
    if (imageUrl && imageUrl.trim().length > 0) {
      allImages.push(imageUrl.trim())
    }
    // Add additional images from Browse API if available
    if (additionalImages && Array.isArray(additionalImages)) {
      additionalImages.forEach((img: any) => {
        const imgUrl = typeof img === 'string' ? img : img?.imageUrl
        if (imgUrl && imgUrl.trim().length > 0 && !allImages.includes(imgUrl)) {
          allImages.push(imgUrl.trim())
        }
      })
    }
    if (allImages.length > 0) {
      productObj.imageUrls = allImages.slice(0, 12) // eBay allows up to 12 images
      debugLog(`Added ${allImages.length} images to product (max 12)`)
    }
    
    // Add product identifiers (UPC, EAN, ISBN, etc.) if provided
    // Priority order: UPC > EAN > ISBN
    if (upc && upc.trim().length > 0) {
      productObj.upc = [upc.trim()]
    }
    if (ean && ean.trim().length > 0) {
      productObj.ean = [ean.trim()]
    }
    if (isbn && isbn.trim().length > 0) {
      productObj.isbn = [isbn.trim()]
    }
    if (mpn && mpn.trim().length > 0) {
      productObj.mpn = mpn.trim()
    }
    if (brand && brand.trim().length > 0) {
      productObj.brand = brand.trim()
    }
    
    // Add product aspects (category-specific attributes) if provided
    // Convert Browse API aspects format to Inventory API format if needed
    let formattedAspects: any = null
    if (aspects && typeof aspects === 'object' && Object.keys(aspects).length > 0) {
      formattedAspects = {}
      
      // Handle both Browse API format (localizedAspects) and direct aspects
      if (Array.isArray(aspects)) {
        // Browse API format: array of {name, value} objects
        aspects.forEach((aspect: any) => {
          if (aspect.name && aspect.value) {
            // Ensure values are arrays
            formattedAspects[aspect.name] = Array.isArray(aspect.value) ? aspect.value : [aspect.value]
          }
        })
      } else {
        // Already in correct format: {Brand: ["Sony"], Model: ["PS5"]}
        // Normalize aspect keys to match eBay's expected format
        formattedAspects = {}
        Object.keys(aspects).forEach(key => {
          const value = aspects[key]
          // Ensure values are arrays
          formattedAspects[key] = Array.isArray(value) ? value : [value]
        })
      }
      
      // Ensure Brand is included (required for most categories)
      if (!formattedAspects.Brand && brand && brand.trim().length > 0) {
        formattedAspects.Brand = [brand.trim()]
        debugLog("Added Brand to aspects from product data")
      }
      
      // Ensure MPN is included if available (required for some categories)
      if (!formattedAspects.MPN && !formattedAspects["Manufacturer Part Number"] && mpn && mpn.trim().length > 0) {
        formattedAspects.MPN = [mpn.trim()]
        debugLog("Added MPN to aspects from product data")
      }
      
      productObj.aspects = formattedAspects
      debugLog("Product aspects included:", Object.keys(formattedAspects).join(", "))
    } else if (brand && brand.trim().length > 0) {
      // If no aspects provided but we have brand, include it
      formattedAspects = {
        Brand: [brand.trim()]
      }
      productObj.aspects = formattedAspects
      debugLog("Created aspects with Brand from product data")
    }
    
    // Determine final category ID before validation
    let finalCategoryId = categoryId
    if (!finalCategoryId && categories && Array.isArray(categories) && categories.length > 0) {
      const primaryCategory = categories[0]
      if (primaryCategory && primaryCategory.categoryId) {
        finalCategoryId = primaryCategory.categoryId
        debugLog("Using category from Browse API:", primaryCategory.categoryName || primaryCategory.categoryId)
      }
    }
    if (!finalCategoryId || finalCategoryId === "") {
      finalCategoryId = "267"
      console.warn("No category provided, using default category 267 (Movies & TV)")
    }
    
    // Validate required aspects BEFORE creating inventory item (prevent error 25002)
    try {
      const validationUrl = `${baseUrl}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${finalCategoryId}`
      const validationResponse = await fetch(validationUrl, {
        headers: ebayHeaders(accessToken),
      })
      
      if (validationResponse.ok) {
        const validationData = await validationResponse.json()
        const requiredAspects: string[] = []
        const aspectDefinitions = validationData.aspects || []
        
        aspectDefinitions.forEach((aspect: any) => {
          if (aspect.aspectConstraint?.aspectRequired === true) {
            requiredAspects.push(aspect.localizedAspectName || aspect.aspectName)
          }
        })
        
        // Check if we have all required aspects
        // Create a map of aspect names (case-insensitive) to their exact keys in formattedAspects
        const aspectNameMap = new Map<string, string>()
        if (formattedAspects) {
          Object.keys(formattedAspects).forEach(key => {
            aspectNameMap.set(key.toLowerCase(), key)
          })
        }
        
        debugLog("Validating required aspects:", {
          requiredAspects,
          currentAspectKeys: formattedAspects ? Object.keys(formattedAspects) : [],
          formattedAspects
        })
        
        const missingAspects: string[] = []
        
        requiredAspects.forEach((requiredAspect: string) => {
          const aspectKeyLower = requiredAspect.toLowerCase()
          const exactKey = aspectNameMap.get(aspectKeyLower)
          
          if (!exactKey) {
            // Try fuzzy matching as fallback
            const fuzzyMatch = Array.from(aspectNameMap.keys()).find(key => 
              key === aspectKeyLower || 
              key.includes(aspectKeyLower) || 
              aspectKeyLower.includes(key)
            )
            
            if (!fuzzyMatch) {
              debugLog(`Missing aspect: "${requiredAspect}" (no match found)`)
              missingAspects.push(requiredAspect)
            } else {
              // Found via fuzzy match, check if it has values
              const matchedKey = aspectNameMap.get(fuzzyMatch)
              const aspectValues = matchedKey ? formattedAspects[matchedKey] : null
              if (!aspectValues || (Array.isArray(aspectValues) && aspectValues.length === 0)) {
                debugLog(`Missing aspect: "${requiredAspect}" (found key "${matchedKey}" but no values)`)
                missingAspects.push(requiredAspect)
              } else {
                debugLog(`Found aspect: "${requiredAspect}" via fuzzy match "${matchedKey}" with values:`, aspectValues)
              }
            }
          } else {
            // Found exact match, check if it has values
            const aspectValues = formattedAspects[exactKey]
            if (!aspectValues || (Array.isArray(aspectValues) && aspectValues.length === 0)) {
              debugLog(`Missing aspect: "${requiredAspect}" (found key "${exactKey}" but no values)`)
              missingAspects.push(requiredAspect)
            } else {
              debugLog(`Found aspect: "${requiredAspect}" with values:`, aspectValues)
            }
          }
        })
        
        if (missingAspects.length > 0) {
          console.warn("Missing required aspects detected:", missingAspects)
          
          // Build aspect definitions for the missing aspects
          const missingAspectDefinitions = missingAspects.map((missingAspect: string) => {
            // Find the aspect definition from taxonomy API
            const aspectDef = aspectDefinitions.find((a: any) => {
              const aspectName = a.localizedAspectName || a.aspectName
              return aspectName === missingAspect || 
                     aspectName?.toLowerCase() === missingAspect.toLowerCase()
            })
            
            if (aspectDef) {
              return {
                name: aspectDef.localizedAspectName || aspectDef.aspectName,
                required: true,
                values: aspectDef.aspectValues?.map((v: any) => v.localizedValue || v.value) || [],
                suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
              }
            } else {
              // Fallback: create basic definition if not found
              return {
                name: missingAspect,
                required: true,
                values: [],
                suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
              }
            }
          })
          
          return NextResponse.json(
            {
              error: `Missing required item specifics for this category`,
              missingItemSpecifics: missingAspects,
              requiredAspects: requiredAspects,
              currentAspects: formattedAspects || {},
              categoryId: finalCategoryId,
              hint: `This category requires the following item specifics: ${missingAspects.join(", ")}. Please provide these details before listing.`,
              action: "missing_item_specifics",
              canRetry: false,
              // Provide aspect definitions for UI - always include them
              aspectDefinitions: missingAspectDefinitions
            },
            { status: 400 }
          )
        }
        
        debugLog("✅ All required aspects validated:", requiredAspects)
      }
    } catch (validationError) {
      // If validation fails, log but continue (don't block listing)
      console.warn("Could not validate aspects (continuing anyway):", validationError)
    }
    
    // Build inventory payload (SKU is in URL, not body!)
    debugLog("[LIST API DEBUG] ========== BUILDING INVENTORY ITEM PAYLOAD ==========")
    debugLog("[LIST API DEBUG] productObj before adding to payload:", JSON.stringify(productObj, null, 2))
    debugLog("[LIST API DEBUG] productObj.description exists:", !!productObj.description)
    debugLog("[LIST API DEBUG] productObj.description value:", productObj.description)
    debugLog("[LIST API DEBUG] productObj.description length:", productObj.description ? productObj.description.length : 0)
    
    const inventoryItemPayload: any = {
      product: productObj,
      condition: mapConditionToEbay(condition),
      availability: {
        shipToLocationAvailability: {
          quantity: 1
        }
      }
    }
    
    // Set seller note in conditionDescription field (this appears as "Seller Notes" on eBay)
    inventoryItemPayload.conditionDescription = sellerNote
    debugLog("[LIST API DEBUG] inventoryItemPayload.conditionDescription:", {
      value: inventoryItemPayload.conditionDescription,
      length: inventoryItemPayload.conditionDescription
        ? inventoryItemPayload.conditionDescription.length
        : 0,
    })
    
    debugLog("[LIST API DEBUG] inventoryItemPayload.product.description:", inventoryItemPayload.product.description)
    debugLog("[LIST API DEBUG] Full inventoryItemPayload:", JSON.stringify(inventoryItemPayload, null, 2))
    
    // Log the payload for debugging
    debugLog("Creating inventory item with payload:", JSON.stringify(inventoryItemPayload, null, 2))
    
    // Log complete request details for Postman
    const inventoryUrl = `${baseUrl}/sell/inventory/v1/inventory_item/${sku}`
    debugLog("=".repeat(80))
    debugLog("API CALL #1: CREATE INVENTORY ITEM")
    debugLog("URL:", inventoryUrl)
    debugLog("Method: PUT")
    debugLog("Headers:", JSON.stringify({
      'Authorization': "Bearer <redacted>",
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    }, null, 2))
    debugLog("Body:", JSON.stringify(inventoryItemPayload, null, 2))
    debugLog("=".repeat(80))

    const inventoryResponse = await fetch(
      inventoryUrl,
      {
        method: "PUT",
        headers: ebayHeaders(accessToken),
        body: JSON.stringify(inventoryItemPayload),
      }
    )

    // Check for 401 Unauthorized - token might be invalid
    if (inventoryResponse.status === 401) {
      console.error("401 Unauthorized from eBay Inventory API - token may be invalid")
      // Don't delete token immediately - might be a temporary issue
      // Only delete if we get error 2004 specifically
    }

    // Check for 204 No Content (success with no body)
    if (inventoryResponse.status === 204) {
      debugLog("✅ Inventory item created successfully (204 No Content)")
    } else if (!inventoryResponse.ok) {
      const { errorData, errorText } = await readErrorBody(inventoryResponse)
      
      // Log full error for debugging
      console.error("eBay Inventory API Error:", {
        status: inventoryResponse.status,
        statusText: inventoryResponse.statusText,
        errorData,
        errorText,
        payload: inventoryItemPayload
      })
      
      const errorMessage = errorData.errors?.[0]?.message || errorData.errors?.[0]?.longMessage || errorData.message || "Failed to create inventory item"
      const errorCode = errorData.errors?.[0]?.errorId || errorData.errors?.[0]?.code
      
      // Provide more specific hints based on error code
      let hint = "Make sure your eBay account has selling privileges and the required permissions."
      let needsReconnect = false
      
      // Error 2004 specifically means "OAuth token is missing required scopes"
      if (errorCode === 2004) {
        console.error("Error 2004 detected: Token missing sell.inventory scope.")
        console.error("Full error details:", JSON.stringify(errorData, null, 2))
        console.error("Current EBAY_SCOPE:", process.env.EBAY_SCOPE)
        needsReconnect = true
        hint = "Error 2004: Your eBay token is missing the 'sell.inventory' scope required for listing. Please disconnect and revoke access, then reconnect your eBay account from the eBay Connect page. Make sure EBAY_SCOPE includes 'sell.inventory' before reconnecting."
      } else if (inventoryResponse.status === 401 && errorCode !== 2004) {
        // 401 but not error 2004 - might be token expired or invalid, but don't delete automatically
        console.error("401 Unauthorized but not error 2004. Error code:", errorCode)
        console.error("Full error details:", JSON.stringify(errorData, null, 2))
        hint = `Authentication error (${errorCode || 'unknown'}): ${errorMessage}. Please try again. If this persists, you may need to reconnect your eBay account.`
      } else if (errorCode === 2001 || errorCode === 2002 || errorCode === 2003) {
        // Other OAuth-related errors that might indicate token issues
        // But don't delete token automatically - let user try again or reconnect manually
        console.error(`OAuth error ${errorCode}:`, errorMessage)
        hint = `eBay API Error ${errorCode}: ${errorMessage}. If this persists, please try disconnecting and reconnecting your eBay account.`
      } else if (errorMessage.includes("seller") || errorMessage.includes("account")) {
        hint = "Your eBay seller account may not be fully set up. Please complete your seller registration on eBay first."
      } else {
        // For other errors, don't delete the token - just show the error
        console.error("Other error (not deleting token):", {
          status: inventoryResponse.status,
          errorCode,
          errorMessage,
          errorData
        })
        hint = errorMessage
      }
      
      return NextResponse.json(
        { 
          error: errorMessage,
          errorCode: errorCode,
          details: errorData,
          hint: hint,
          needsReconnect: needsReconnect,
          rawEbayError: errorData, // Full raw error from eBay
          ebayErrorMessage: errorData.errors?.[0] || errorData // First error or full error object
        },
        { status: inventoryResponse.status }
      )
    }

    // Handle response - 204 returns no body
    let inventoryData: any = {}
    if (inventoryResponse.status !== 204) {
      inventoryData = await inventoryResponse.json().catch(() => ({}))
    }
    // Use the SKU we provided (since 204 returns no body)
    const finalSku = inventoryData.sku || sku

    // Step 2: Get user's inventory location (required for publishing)
    let merchantLocationKey = ""
    
    try {
      debugLog("Fetching inventory locations...")
      const locationsResponse = await fetch(
        `${baseUrl}/sell/inventory/v1/location`,
        {
          headers: ebayHeaders(accessToken),
        }
      )
      
      if (locationsResponse.ok) {
        const locationsData = await locationsResponse.json()
        if (locationsData.locations && locationsData.locations.length > 0) {
          merchantLocationKey = locationsData.locations[0].merchantLocationKey
          debugLog("Found inventory location:", merchantLocationKey)
        } else {
          console.warn("No inventory locations found for user")
        }
      } else {
        console.error("Failed to fetch inventory locations:", locationsResponse.status)
      }
    } catch (locationError) {
      console.error("Error fetching inventory locations:", locationError)
    }
    
    // If no location found, we cannot publish the listing
    if (!merchantLocationKey || merchantLocationKey === "") {
      return NextResponse.json(
        { 
          error: "No inventory location found. Please set up your inventory location in eBay Seller Hub first.",
          hint: "Go to eBay Seller Hub → Account → Business Policies → Locations and create a location with your address.",
          needsSetup: true,
          setupUrl: "https://www.ebay.com/sh/locationsettings"
        },
        { status: 400 }
      )
    }

    // Step 3: Get user's saved policies or fetch from eBay
    let fulfillmentPolicyId = "default"
    let paymentPolicyId = "default"
    let returnPolicyId = "default"
    
    try {
      // savedPolicies was loaded in parallel with the other user settings above
      if (savedPolicies) {
        // Use saved policies if available
        if (savedPolicies.fulfillmentPolicyId) {
          fulfillmentPolicyId = savedPolicies.fulfillmentPolicyId
        }
        if (savedPolicies.paymentPolicyId) {
          paymentPolicyId = savedPolicies.paymentPolicyId
        }
        if (savedPolicies.returnPolicyId) {
          returnPolicyId = savedPolicies.returnPolicyId
        }
        debugLog("Using saved policies:", { fulfillmentPolicyId, paymentPolicyId, returnPolicyId })
      } else {
        // Fall back to fetching policies from eBay - the three policy types
        // are independent, so fetch them in parallel
        debugLog("No saved policies found, fetching from eBay...")

        const fetchFirstPolicy = async (
          endpoint: string,
          listKey: string,
          idKey: string
        ): Promise<string | null> => {
          try {
            const response = await fetch(`${baseUrl}/sell/account/v1/${endpoint}`, {
              headers: ebayHeaders(accessToken),
            })
            if (!response.ok) return null
            const data = await response.json()
            return data[listKey]?.[0]?.[idKey] ?? null
          } catch (err) {
            console.error(`Failed to fetch ${endpoint}:`, err)
            return null
          }
        }

        const [fetchedFulfillment, fetchedPayment, fetchedReturn] = await Promise.all([
          fetchFirstPolicy("fulfillment_policy", "fulfillmentPolicies", "fulfillmentPolicyId"),
          fetchFirstPolicy("payment_policy", "paymentPolicies", "paymentPolicyId"),
          fetchFirstPolicy("return_policy", "returnPolicies", "returnPolicyId"),
        ])

        if (fetchedFulfillment) fulfillmentPolicyId = fetchedFulfillment
        if (fetchedPayment) paymentPolicyId = fetchedPayment
        if (fetchedReturn) returnPolicyId = fetchedReturn
        debugLog("Fetched policies from eBay:", { fulfillmentPolicyId, paymentPolicyId, returnPolicyId })
      }
    } catch (policyError) {
      console.error("Error fetching policies:", policyError)
      // Use defaults if policy fetch fails
    }

    // Global offer settings (Allow Offers + Minimum Offer Amount) were loaded
    // in parallel with the other user settings above
    const allowOffers = !!offerSettings?.allowOffers
    const minimumOfferAmount = Number(offerSettings?.minimumOfferAmount ?? 10.0)

    debugLog("[LIST API DEBUG] Offer settings loaded:", {
      allowOffers,
      minimumOfferAmount,
      listingPrice: priceNum,
    })

    if (allowOffers) {
      if (Number.isNaN(minimumOfferAmount) || minimumOfferAmount <= 0) {
        return NextResponse.json(
          {
            error: "Minimum offer amount must be greater than 0 when Allow Offers is enabled.",
            action: "invalid_offer_settings",
          },
          { status: 400 }
        )
      }

      if (minimumOfferAmount >= priceNum) {
        return NextResponse.json(
          {
            error: `Minimum offer amount ($${minimumOfferAmount.toFixed(2)}) must be lower than listing price ($${priceNum.toFixed(2)}).`,
            action: "invalid_offer_settings",
          },
          { status: 400 }
        )
      }
    }

    // Step 4: Create an offer
    // finalCategoryId is already determined during validation above
    
    debugLog("[LIST API DEBUG] ========== BUILDING OFFER PAYLOAD ==========")
    debugLog("[LIST API DEBUG] Creating offer payload with description:", {
      description: description,
      descriptionLength: description ? description.length : 0,
      descriptionPreview: description ? description.substring(0, 100) : "null/undefined",
      willUse: description ? description.substring(0, 50000) : null,
      willUseLength: description ? Math.min(description.length, 50000) : 0
    })
    
    const listingDescriptionForOffer = description ? description.substring(0, 50000) : ""
    debugLog("[LIST API DEBUG] listingDescriptionForOffer:", {
      value: listingDescriptionForOffer,
      length: listingDescriptionForOffer.length,
      preview: listingDescriptionForOffer.substring(0, 100)
    })
    
    const offerPayload: any = {
      sku: finalSku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      listingDescription: listingDescriptionForOffer, // eBay description limit (seller note is in conditionDescription, not here)
      listingDuration: "GTC", // Good 'Til Cancelled - recommended for fixed price
      includeCatalogProductDetails: true, // Use eBay catalog data when available
      pricingSummary: {
        price: {
          value: parseFloat(price).toFixed(2),
          currency: "USD",
        },
      },
      categoryId: finalCategoryId,
      availableQuantity: 1, // Explicit quantity (recommended)
      merchantLocationKey: merchantLocationKey, // Required for publishing
    }

    if (allowOffers) {
      offerPayload.bestOfferTerms = {
        bestOfferEnabled: true,
        minimumBestOfferAmount: {
          value: minimumOfferAmount.toFixed(2),
          currency: "USD",
        },
      }
    }
    
    // Add listing policies if we have them
    if (fulfillmentPolicyId !== "default" || paymentPolicyId !== "default" || returnPolicyId !== "default") {
      offerPayload.listingPolicies = {
        fulfillmentPolicyId: fulfillmentPolicyId,
        paymentPolicyId: paymentPolicyId,
        returnPolicyId: returnPolicyId,
      }
    }
    
    debugLog("[LIST API DEBUG] ========== OFFER PAYLOAD BEFORE SENDING ==========")
    debugLog("[LIST API DEBUG] offerPayload.listingDescription:", {
      exists: !!offerPayload.listingDescription,
      value: offerPayload.listingDescription,
      length: offerPayload.listingDescription ? offerPayload.listingDescription.length : 0,
      preview: offerPayload.listingDescription ? offerPayload.listingDescription.substring(0, 100) : "null/undefined"
    })
    debugLog("[LIST API DEBUG] Full offerPayload:", JSON.stringify(offerPayload, null, 2))
    
    debugLog("Offer payload includes:", {
      listingDuration: offerPayload.listingDuration,
      listingDescription: offerPayload.listingDescription ? `${offerPayload.listingDescription.substring(0, 50)}... (${offerPayload.listingDescription.length} chars)` : "MISSING",
      includeCatalogProductDetails: offerPayload.includeCatalogProductDetails,
      categoryId: finalCategoryId,
      hasEpid: !!epid,
      imageCount: allImages.length,
      hasAspects: !!productObj.aspects,
      aspectsCount: productObj.aspects ? Object.keys(productObj.aspects).length : 0,
      aspects: productObj.aspects ? Object.keys(productObj.aspects) : []
    })
    
    // Log complete request details for Postman
    const offerUrl = `${baseUrl}/sell/inventory/v1/offer`
    debugLog("=".repeat(80))
    debugLog("API CALL #4: CREATE OFFER")
    debugLog("URL:", offerUrl)
    debugLog("Method: POST")
    debugLog("Headers:", JSON.stringify({
      'Authorization': "Bearer <redacted>",
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    }, null, 2))
    debugLog("Body:", JSON.stringify(offerPayload, null, 2))
    debugLog("=".repeat(80))

    const offerResponse = await fetch(
      offerUrl,
      {
        method: "POST",
        headers: ebayHeaders(accessToken),
        body: JSON.stringify(offerPayload),
      }
    )
    
    debugLog("[LIST API DEBUG] ========== OFFER API RESPONSE ==========")
    debugLog("[LIST API DEBUG] Offer API Response Status:", offerResponse.status, offerResponse.statusText)

    if (!offerResponse.ok) {
      // Body can only be read once - read it here and reuse for all checks below
      const { errorData } = await readErrorBody(offerResponse)

      // Check for 401 Unauthorized - token might be invalid
      if (offerResponse.status === 401) {
        console.error("401 Unauthorized from eBay Offer API - token may be invalid")
        const authErrorCode = errorData.errors?.[0]?.errorId || errorData.errors?.[0]?.code

        if (authErrorCode === 2004) {
          console.error("Error 2004 in offer creation - token missing required scopes.")
          return NextResponse.json(
            {
              error: "Your eBay token is missing the required 'sell.inventory' scope for creating offers. Please disconnect and reconnect your eBay account.",
              errorCode: 2004,
              needsReconnect: true,
            },
            { status: 401 }
          )
        }
      }

      const errorCode = errorData.errors?.[0]?.errorId
      
      // Error 25002: Offer already exists - try to update existing offer instead
      if (errorCode === 25002) {
        debugLog("Offer already exists, attempting to update existing offer...")
        const existingOfferId = errorData.errors?.[0]?.parameters?.find((p: any) => p.name === "offerId")?.value
        
        if (existingOfferId) {
          debugLog("Found existing offer ID:", existingOfferId)
          
          // Try to update the existing offer
          const updateUrl = `${baseUrl}/sell/inventory/v1/offer/${existingOfferId}`
          debugLog("Updating existing offer:", updateUrl)
          
          const updateResponse = await fetch(updateUrl, {
            method: "PUT",
            headers: ebayHeaders(accessToken),
            body: JSON.stringify(offerPayload),
          })
          
          if (updateResponse.ok) {
            debugLog("✅ Existing offer updated successfully")
            // Use the existing offer ID to publish
            const offerId = existingOfferId
            await logOfferState(baseUrl, accessToken, offerId, "AFTER_EXISTING_OFFER_UPDATE_BEFORE_PUBLISH")
            
            // Continue to Step 5: Publish the offer
            const publishUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}/publish`
            debugLog("=".repeat(80))
            debugLog("API CALL #5: PUBLISH OFFER (existing)")
            debugLog("URL:", publishUrl)
            debugLog("=".repeat(80))
            
            const publishResponse = await fetch(publishUrl, {
              method: "POST",
              headers: ebayHeaders(accessToken),
            })
            
            if (!publishResponse.ok) {
              const { errorData: publishErrorData } = await readErrorBody(publishResponse)
              const publishErrorMessage = publishErrorData.errors?.[0]?.message || "Failed to publish existing offer"
              const publishErrorCode = publishErrorData.errors?.[0]?.errorId
              const publishErrorParams = publishErrorData.errors?.[0]?.parameters || []
              
              // Extract missing item specific info
              let missingAspectsList: string[] = []
              let aspectDefinitionsList: any[] = []
              
              publishErrorParams.forEach((param: any) => {
                if (param.name === "2" && param.value) {
                  missingAspectsList = [param.value]
                }
              })
              
              // If missing aspects found, fetch definitions
              if (publishErrorCode === 25002 && missingAspectsList.length > 0) {
                try {
                  const taxonomyUrl = `${baseUrl}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${finalCategoryId}`
                  const taxonomyResponse = await fetch(taxonomyUrl, {
                    headers: ebayHeaders(accessToken),
                  })
                  
                  if (taxonomyResponse.ok) {
                    const taxonomyData = await taxonomyResponse.json()
                    const allAspects = taxonomyData.aspects || []
                    
                    missingAspectsList.forEach((missingAspect: string) => {
                      const aspectDef = allAspects.find((a: any) => 
                        (a.localizedAspectName || a.aspectName) === missingAspect ||
                        (a.localizedAspectName || a.aspectName)?.toLowerCase() === missingAspect.toLowerCase()
                      )
                      if (aspectDef) {
                        aspectDefinitionsList.push({
                          name: aspectDef.localizedAspectName || aspectDef.aspectName,
                          required: true,
                          values: aspectDef.aspectValues?.map((v: any) => v.localizedValue || v.value) || [],
                          suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
                        })
                      } else {
                        aspectDefinitionsList.push({
                          name: missingAspect,
                          required: true,
                          values: [],
                          suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
                        })
                      }
                    })
                  }
                } catch (taxonomyError) {
                  console.warn("Could not fetch aspect definitions:", taxonomyError)
                  missingAspectsList.forEach((missingAspect: string) => {
                    aspectDefinitionsList.push({
                      name: missingAspect,
                      required: true,
                      values: [],
                      suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
                    })
                  })
                }
              }
              
              let hint = "Offer updated but not published. "
              if (publishErrorCode === 25002 && missingAspectsList.length > 0) {
                hint += `Missing required item specific: "${missingAspectsList.join(", ")}". This category requires this attribute to be specified.`
              } else {
                hint += "You can publish it manually from your eBay Seller Hub."
              }
              
              console.error("Publish updated offer failed:", {
                errorCode: publishErrorCode,
                missingAspectsList,
                message: publishErrorMessage
              })
              
              // Return format that frontend expects for missing item specifics
              if (publishErrorCode === 25002 && missingAspectsList.length > 0) {
                return NextResponse.json(
                  {
                    error: publishErrorMessage,
                    action: "missing_item_specifics",
                    missingItemSpecifics: missingAspectsList,
                    aspectDefinitions: aspectDefinitionsList,
                    currentAspects: productObj.aspects || {},
                    categoryId: finalCategoryId,
                    hint: hint,
                    offerId: offerId,
                    sku: finalSku,
                    details: publishErrorData,
                    rawEbayError: publishErrorData,
                    canRetry: false,
                    updated: true,
                  },
                  { status: publishResponse.status }
                )
              }
              
              return NextResponse.json(
                { 
                  error: publishErrorMessage,
                  details: publishErrorData,
                  offerId: offerId,
                  sku: finalSku,
                  hint: hint,
                  missingItemSpecific: missingAspectsList[0] || null,
                  action: "publish_failed",
                  updated: true,
                },
                { status: publishResponse.status }
              )
            }
            
            const publishData = await publishResponse.json()
            await logOfferState(baseUrl, accessToken, offerId, "AFTER_EXISTING_OFFER_PUBLISH")

            let bestOfferFixResult: { ensured: boolean; attempted: boolean } | null = null
            let bestOfferRecreateResult:
              | { recreated: boolean; ensured: boolean; recreatedOfferId?: string; recreatedListingId?: string }
              | null = null
            if (allowOffers) {
              bestOfferFixResult = await tryEnsureBestOfferTerms(
                baseUrl,
                accessToken,
                offerId,
                offerPayload
              )

              if (!bestOfferFixResult.ensured) {
                bestOfferRecreateResult = await recreateOfferWithBestOffer(
                  baseUrl,
                  accessToken,
                  offerId,
                  offerPayload
                )
              }
            }
            
            // SKU counter was already claimed atomically before listing
            return NextResponse.json({
              success: true,
              message: "Product listing updated and published successfully on eBay",
              listingId: bestOfferRecreateResult?.recreatedListingId || publishData.listingId,
              offerId: bestOfferRecreateResult?.recreatedOfferId || offerId,
              sku: finalSku,
              listingUrl: `https://www.ebay.com/itm/${bestOfferRecreateResult?.recreatedListingId || publishData.listingId}`,
              updated: true, // Flag to indicate this was an update, not new listing
              bestOfferEnabledRequested: allowOffers,
              bestOfferEnsured:
                allowOffers && (bestOfferRecreateResult || bestOfferFixResult)
                  ? !!(bestOfferRecreateResult?.ensured || bestOfferFixResult?.ensured)
                  : undefined,
              bestOfferRetryAttempted:
                allowOffers && bestOfferFixResult
                  ? bestOfferFixResult.attempted
                  : undefined,
              bestOfferRecreateAttempted:
                allowOffers && bestOfferFixResult && !bestOfferFixResult.ensured
                  ? true
                  : false,
            })
          } else {
            const { errorData: updateErrorData } = await readErrorBody(updateResponse)
            console.error("Failed to update existing offer:", updateErrorData)
            
            // If update fails, suggest deleting and trying again
            return NextResponse.json(
              { 
                error: "An offer already exists for this SKU and could not be updated. Please try a different product or wait a moment.",
                details: updateErrorData,
                existingOfferId: existingOfferId,
                hint: "The SKU is already in use. Either list a different product or contact support to remove the existing offer.",
              },
              { status: 409 } // 409 Conflict
            )
          }
        }
      }
      
      // If offer creation fails for other reasons, try to clean up the inventory item
      try {
        await fetch(`${baseUrl}/sell/inventory/v1/inventory_item/${finalSku}`, {
          method: "DELETE",
          headers: ebayHeaders(accessToken),
        })
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      const errorMessage = errorData.errors?.[0]?.message || errorData.errors?.[0]?.longMessage || "Failed to create offer"
      let hint = "You may need to set up fulfillment, payment, and return policies in your eBay account first."
      
      // Provide more specific hints based on error
      if (errorMessage.includes("policy") || errorMessage.includes("Policy")) {
        hint = "Please set up fulfillment, payment, and return policies in your eBay Seller Hub first."
      } else if (errorMessage.includes("category") || errorMessage.includes("Category")) {
        hint = "The category ID might be invalid. Please check the product category."
      } else if (errorMessage.includes("SKU") || errorMessage.includes("sku")) {
        hint = "There was an issue with the product SKU. Please try again."
      }

      return NextResponse.json(
        { 
          error: errorMessage,
          details: errorData,
          hint: hint,
          rawEbayError: errorData, // Full raw error from eBay
          ebayErrorMessage: errorData.errors?.[0] || errorData // First error or full error object
        },
        { status: offerResponse.status }
      )
    }

    const offerData = await offerResponse.json()
    debugLog("[LIST API DEBUG] ========== OFFER CREATED SUCCESSFULLY ==========")
    debugLog("[LIST API DEBUG] Offer Response Data:", JSON.stringify(offerData, null, 2))
    debugLog("[LIST API DEBUG] Offer ID:", offerData.offerId)
    
    const offerId = offerData.offerId

    if (!offerId) {
      return NextResponse.json(
        { 
          error: "Offer created but no offer ID returned",
          details: offerData,
        },
        { status: 500 }
      )
    }

    await logOfferState(baseUrl, accessToken, offerId, "AFTER_OFFER_CREATE_BEFORE_PUBLISH")

    // Step 5: Publish the offer
    // Log what we're attempting to publish
    debugLog("=".repeat(80))
    debugLog("PREPARING TO PUBLISH OFFER")
    debugLog("Offer ID:", offerId)
    debugLog("SKU:", finalSku)
    debugLog("Category:", finalCategoryId)
    debugLog("Has Product Aspects:", !!productObj.aspects)
    if (productObj.aspects) {
      debugLog("Product Aspects:", JSON.stringify(productObj.aspects, null, 2))
    }
    debugLog("Has Business Policies:", !!(fulfillmentPolicyId !== "default" && paymentPolicyId !== "default" && returnPolicyId !== "default"))
    debugLog("Merchant Location Key:", merchantLocationKey)
    debugLog("=".repeat(80))
    
    const publishUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}/publish`
    debugLog("=".repeat(80))
    debugLog("API CALL #5: PUBLISH OFFER")
    debugLog("URL:", publishUrl)
    debugLog("Method: POST")
    debugLog("Headers:", JSON.stringify({
      'Authorization': "Bearer <redacted>",
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    }, null, 2))
    debugLog("Body: {} (empty)")
    debugLog("=".repeat(80))
    
    const publishResponse = await fetch(
      publishUrl,
      {
        method: "POST",
        headers: ebayHeaders(accessToken),
      }
    )

    if (!publishResponse.ok) {
      // Body can only be read once - read it here and reuse for all checks below
      const { errorData } = await readErrorBody(publishResponse)

      // Check for 401 Unauthorized - token might be invalid
      if (publishResponse.status === 401) {
        console.error("401 Unauthorized from eBay Publish API - token may be invalid")
        const authErrorCode = errorData.errors?.[0]?.errorId || errorData.errors?.[0]?.code

        if (authErrorCode === 2004) {
          console.error("Error 2004 in publish - token missing required scopes.")
          return NextResponse.json(
            {
              error: "Your eBay token is missing the required 'sell.inventory' scope for publishing listings. Please disconnect and reconnect your eBay account.",
              errorCode: 2004,
              needsReconnect: true,
            },
            { status: 401 }
          )
        }
      }

      const errorMessage = errorData.errors?.[0]?.message || errorData.errors?.[0]?.longMessage || "Failed to publish listing"
      const errorCode = errorData.errors?.[0]?.errorId
      const errorParameters = errorData.errors?.[0]?.parameters || []
      
      // Extract missing item specific from error if available
      let missingSpecific = null
      let specificHint = ""
      
      // Error 25002 can mean missing required item specifics
      let missingAspectsList: string[] = []
      let aspectDefinitionsList: any[] = []
      
      if (errorCode === 25002) {
        // Try to extract the missing specific name from parameters
        errorParameters.forEach((param: any) => {
          if (param.name === "2") {
            // Parameter with name "2" contains the missing field name
            missingSpecific = param.value
            if (missingSpecific) {
              missingAspectsList = [missingSpecific]
            }
          }
        })
        
        // If we found a missing specific, fetch aspect definitions for the form
        if (missingAspectsList.length > 0) {
          try {
            const taxonomyUrl = `${baseUrl}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${finalCategoryId}`
            const taxonomyResponse = await fetch(taxonomyUrl, {
              headers: ebayHeaders(accessToken),
            })
            
            if (taxonomyResponse.ok) {
              const taxonomyData = await taxonomyResponse.json()
              const allAspects = taxonomyData.aspects || []
              
              // Get definitions for missing aspects
              missingAspectsList.forEach((missingAspect: string) => {
                const aspectDef = allAspects.find((a: any) => 
                  (a.localizedAspectName || a.aspectName) === missingAspect ||
                  (a.localizedAspectName || a.aspectName)?.toLowerCase() === missingAspect.toLowerCase()
                )
                if (aspectDef) {
                  aspectDefinitionsList.push({
                    name: aspectDef.localizedAspectName || aspectDef.aspectName,
                    required: true,
                    values: aspectDef.aspectValues?.map((v: any) => v.localizedValue || v.value) || [],
                    // Try to extract suggested value from shortDescription or title
                    suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
                  })
                } else {
                  // If not found, add a basic definition
                  aspectDefinitionsList.push({
                    name: missingAspect,
                    required: true,
                    values: [],
                    suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
                  })
                }
              })
            }
          } catch (taxonomyError) {
            console.warn("Could not fetch aspect definitions:", taxonomyError)
            // Add basic definitions anyway
            missingAspectsList.forEach((missingAspect: string) => {
              aspectDefinitionsList.push({
                name: missingAspect,
                required: true,
                values: [],
                suggestedValue: extractAspectValue(missingAspect, shortDescription || description || title || "")
              })
            })
          }
        }
        
        if (missingSpecific) {
          specificHint = `The category requires "${missingSpecific}" to be specified. This is a required item specific for this product category. Please provide this information to continue.`
        } else {
          // General missing item specific error
          const errorMsg = errorParameters.find((p: any) => p.name === "0" || p.name === "1")?.value || ""
          if (errorMsg.includes("item specific")) {
            specificHint = "This product category requires specific item attributes that are missing. Common required attributes include: Brand, Model, Platform (for video games), Size (for clothing), Color, etc. Make sure the product search returns complete data with all required attributes."
          }
        }
      }
      
      // Build comprehensive error response
      let hint = specificHint || "Offer created but not published. You can publish it manually from your eBay Seller Hub."
      
      // Additional hints based on error patterns
      if (errorMessage.includes("policy") || errorMessage.includes("Policy")) {
        hint = "Missing or invalid business policies. Please verify your payment, return, and fulfillment policies are set up correctly in eBay Seller Hub."
      } else if (errorMessage.includes("location")) {
        hint = "Invalid or missing inventory location. Please set up your inventory location in eBay Seller Hub first."
      }
      
      console.error("Publish failed:", {
        errorCode,
        errorMessage,
        missingSpecific,
        missingAspectsList,
        parameters: errorParameters
      })
      
      // If this is a missing item specifics error, return format that frontend expects
      if (errorCode === 25002 && missingAspectsList.length > 0) {
        return NextResponse.json(
          {
            error: errorMessage,
            action: "missing_item_specifics", // Plural to match frontend check
            missingItemSpecifics: missingAspectsList, // Plural array
            aspectDefinitions: aspectDefinitionsList,
            currentAspects: productObj.aspects || {},
            categoryId: finalCategoryId,
            hint: hint,
            offerId: offerId,
            sku: finalSku,
            details: errorData,
            rawEbayError: errorData,
            canRetry: false,
          },
          { status: publishResponse.status }
        )
      }
      
      return NextResponse.json(
        { 
          error: errorMessage,
          details: errorData,
          offerId: offerId,
          sku: finalSku,
          hint: hint,
          missingItemSpecific: missingSpecific,
          rawEbayError: errorData,
          ebayErrorMessage: errorData.errors?.[0] || errorData,
          // Provide actionable information
          action: "publish_failed",
          canRetry: errorCode !== 25002, // Can't retry if item specifics are missing
        },
        { status: publishResponse.status }
      )
    }

    debugLog("[LIST API DEBUG] ========== PUBLISH RESPONSE ==========")
    debugLog("[LIST API DEBUG] Publish Response Status:", publishResponse.status, publishResponse.statusText)
    
    const publishData = await publishResponse.json()
    await logOfferState(baseUrl, accessToken, offerId, "AFTER_OFFER_PUBLISH")
    
    debugLog("[LIST API DEBUG] Publish Response Data:", JSON.stringify(publishData, null, 2))
    debugLog("[LIST API DEBUG] Listing ID:", publishData.listingId)
    debugLog("[LIST API DEBUG] Warnings:", publishData.warnings || "None")
    debugLog("[LIST API DEBUG] ========== LISTING COMPLETE ==========")

    // SKU counter was already claimed atomically before listing
    return NextResponse.json({
      success: true,
      message: "Product listed successfully on eBay",
      listingId: publishData.listingId,
      offerId: offerId,
      sku: finalSku,
      listingUrl: `https://www.ebay.com/itm/${publishData.listingId}`,
    })
  } catch (error) {
    console.error("[LIST API DEBUG] ========== ERROR IN LISTING ==========")
    console.error("[LIST API DEBUG] Error type:", error instanceof Error ? error.constructor.name : typeof error)
    console.error("[LIST API DEBUG] Error message:", error instanceof Error ? error.message : String(error))
    console.error("[LIST API DEBUG] Error stack:", error instanceof Error ? error.stack : "No stack trace")
    console.error("[LIST API DEBUG] Full error object:", error)
    return NextResponse.json(
      { 
        error: "Something went wrong", 
        details: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

// Helper function to extract aspect value from text (shortDescription, title, etc.)
function extractAspectValue(aspectName: string, text: string): string | null {
  if (!text) return null
  
  const aspectLower = aspectName.toLowerCase()
  const textLower = text.toLowerCase()
  
  // Try to find "Platform: value" pattern
  if (aspectLower === "platform") {
    // Pattern: "Platform: Sony Playstation 5" or "Platform: PlayStation 5"
    const platformMatch = text.match(/platform:\s*([^.,;]+)/i)
    if (platformMatch && platformMatch[1]) {
      return platformMatch[1].trim()
    }
    
    // Try to find in title: "PS5", "PlayStation 5", "Xbox", etc.
    if (textLower.includes("ps5") || textLower.includes("playstation 5")) {
      return "PlayStation 5"
    }
    if (textLower.includes("ps4") || textLower.includes("playstation 4")) {
      return "PlayStation 4"
    }
    if (textLower.includes("xbox one")) {
      return "Xbox One"
    }
    if (textLower.includes("xbox series")) {
      return "Xbox Series X|S"
    }
    if (textLower.includes("nintendo switch")) {
      return "Nintendo Switch"
    }
    if (textLower.includes("pc") && !textLower.includes("ps")) {
      return "PC"
    }
  }
  
  // Generic pattern: "AspectName: value"
  const genericMatch = new RegExp(`${aspectName}:\\s*([^.,;]+)`, "i")
  const match = text.match(genericMatch)
  if (match && match[1]) {
    return match[1].trim()
  }
  
  return null
}

// Helper function to map condition to eBay condition enum
function mapConditionToEbay(condition: string): string {
  const conditionMap: { [key: string]: string } = {
    "Brand New": "NEW",
    "New Other": "NEW_OTHER",
    "New with Defects": "NEW_WITH_DEFECTS",
    "Manufacturer Refurbished": "MANUFACTURER_REFURBISHED",
    "Seller Refurbished": "SELLER_REFURBISHED",
    "Used - Excellent": "USED_EXCELLENT",
    "Used - Very Good": "USED_VERY_GOOD",
    "Used - Good": "USED_GOOD",
    "Used - Acceptable": "USED_ACCEPTABLE",
    "For Parts or Not Working": "FOR_PARTS_OR_NOT_WORKING",
  }
  
  return conditionMap[condition] || "NEW"
}

// Helper function to get condition description text
// Note: eBay ignores conditionDescription for brand new items (NEW condition)
function getConditionDescription(condition: string): string {
  const descriptionMap: { [key: string]: string } = {
    // Brand New items should not include conditionDescription per eBay API guidelines
    "Brand New": "",
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

