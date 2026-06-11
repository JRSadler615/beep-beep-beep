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

// Helper function to update quantity via Trading API (for listings not created via Inventory API)
async function updateViaTradingAPI(
  accessToken: string,
  itemId: string,
  sku: string | null,
  newQuantity: number,
  isSandbox: boolean
): Promise<{ success: boolean; error?: string; details?: any }> {
  const tradingApiUrl = isSandbox
    ? "https://api.sandbox.ebay.com/ws/api.dll"
    : "https://api.ebay.com/ws/api.dll"
  
  // Use ReviseItem with Quantity field - this is the correct way to update quantity
  // for listings created via Trading API or eBay web interface
  const itemIdentifier = itemId 
    ? `<ItemID>${itemId}</ItemID>`
    : sku 
    ? `<SKU>${sku}</SKU>`
    : ""
  
  if (!itemIdentifier) {
    return { success: false, error: "Either ItemID or SKU is required for Trading API update" }
  }
  
  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${accessToken}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    ${itemIdentifier}
    <Quantity>${newQuantity}</Quantity>
  </Item>
  <WarningLevel>High</WarningLevel>
</ReviseItemRequest>`

  debugLog(`[TRADING API] Sending ReviseItem request for ${itemId ? `ItemID: ${itemId}` : `SKU: ${sku}`} with Quantity: ${newQuantity}`)
  
  const response = await fetch(tradingApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0", // US site
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
      "X-EBAY-API-CALL-NAME": "ReviseItem",
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body: xmlRequest,
  })

  const responseText = await response.text()
  debugLog(`[TRADING API] Response status: ${response.status}`)
  debugLog(`[TRADING API] Response body:`, responseText.substring(0, 1000))

  // Parse XML response to check for success/failure
  if (responseText.includes("<Ack>Success</Ack>") || responseText.includes("<Ack>Warning</Ack>")) {
    debugLog(`[TRADING API] ✅ Successfully updated quantity to ${newQuantity}`)
    return { success: true }
  } else {
    // Extract error message from XML
    // Use [\s\S] instead of /s flag for compatibility with older TypeScript targets
    const errorMatch = responseText.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)
    const longErrorMatch = responseText.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)
    const errorMessage = longErrorMatch?.[1] || errorMatch?.[1] || "Unknown error"
    console.error(`[TRADING API] ❌ Failed to update quantity:`, errorMessage)
    return { success: false, error: errorMessage, details: responseText }
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const body = await req.json()
    const { sku, upc } = body

    if (!sku && !upc) {
      return NextResponse.json(
        { error: "Either SKU or UPC is required" },
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

    const isSandbox = process.env.EBAY_SANDBOX === "true"
    const baseUrl = getEbayBaseUrl()

    // Strategy: First try to find published offer by SKU, if that fails and we have UPC, search by UPC
    let offers: any[] = []
    let offersUrl = ""
    
    // First, try to find offers by SKU if provided
    if (sku) {
      offersUrl = `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=25`
      debugLog(`[INVENTORY] Searching offers by SKU: ${sku}`)
    } else if (upc) {
      // If no SKU but we have UPC, we need to search inventory items by UPC first
      // Then find offers for those inventory items
      debugLog(`[INVENTORY] No SKU provided, searching by UPC: ${upc}`)
      
      // Get inventory items by UPC
      const inventoryUrl = `${baseUrl}/sell/inventory/v1/inventory_item?limit=25&offset=0`
      const inventoryResponse = await fetch(inventoryUrl, {
        headers: ebayHeaders(accessToken),
      })
      
      if (inventoryResponse.ok) {
        const inventoryData = await inventoryResponse.json()
        const inventoryItems = inventoryData.inventoryItems || []
        
        // Find inventory items matching the UPC
        const matchingItems = []
        for (const item of inventoryItems) {
          const product = item.product
          if (product) {
            // Check UPC in various formats
            const itemUpc = product.upc || product.gtin || (product.productIdentifiers?.find((pi: any) => pi.type === "UPC")?.value)
            if (itemUpc && String(itemUpc).replace(/\D/g, "") === String(upc).replace(/\D/g, "")) {
              matchingItems.push(item.sku)
            }
          }
        }
        
        debugLog(`[INVENTORY] Found ${matchingItems.length} inventory item(s) matching UPC`)
        
        // Now get offers for these SKUs
        for (const itemSku of matchingItems) {
          const itemOffersUrl = `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(itemSku)}&limit=25`
          const itemOffersResponse = await fetch(itemOffersUrl, {
            headers: ebayHeaders(accessToken),
          })
          
          if (itemOffersResponse.ok) {
            const itemOffersData = await itemOffersResponse.json()
            offers.push(...(itemOffersData.offers || []))
          }
        }
      }
    }
    
    // If we have a SKU, fetch offers by SKU first
    if (sku && offers.length === 0) {
      offersUrl = `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=25`
      
      const offersResponse = await fetch(offersUrl, {
        headers: ebayHeaders(accessToken),
      })

      if (offersResponse.ok) {
        const offersData = await offersResponse.json()
        offers.push(...(offersData.offers || []))
      }
    }
    
    debugLog(`[INVENTORY] Found ${offers.length} offer(s) initially`)
    
    // Find the PUBLISHED offer (the one that's actually listed on eBay)
    // Priority: PUBLISHED with listing > PUBLISHED > any other status
    let offer = offers.find((o: any) => o.status === "PUBLISHED" && o.listing?.listingId)
    if (!offer) {
      offer = offers.find((o: any) => o.status === "PUBLISHED")
    }
    
    // If no published offer found and we have UPC, search by UPC to find published listing
    if (!offer && upc) {
      debugLog(`[INVENTORY] No published offer found by SKU, searching by UPC: ${upc}`)
      
      // Get all inventory items
      const inventoryUrl = `${baseUrl}/sell/inventory/v1/inventory_item?limit=50&offset=0`
      const inventoryResponse = await fetch(inventoryUrl, {
        headers: ebayHeaders(accessToken),
      })
      
      if (inventoryResponse.ok) {
        const inventoryData = await inventoryResponse.json()
        const inventoryItems = inventoryData.inventoryItems || []
        
        // Find inventory items matching the UPC
        const matchingSkus: string[] = []
        for (const item of inventoryItems) {
          const product = item.product
          if (product) {
            // Check UPC in various formats
            const itemUpc = product.upc?.[0] || product.gtin || (product.productIdentifiers?.find((pi: any) => pi.type === "UPC")?.value)
            if (itemUpc && String(itemUpc).replace(/\D/g, "") === String(upc).replace(/\D/g, "")) {
              matchingSkus.push(item.sku)
            }
          }
        }
        
        debugLog(`[INVENTORY] Found ${matchingSkus.length} inventory item(s) matching UPC: ${matchingSkus.join(", ")}`)
        
        // Get offers for all matching SKUs
        for (const itemSku of matchingSkus) {
          const itemOffersUrl = `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(itemSku)}&limit=25`
          const itemOffersResponse = await fetch(itemOffersUrl, {
            headers: ebayHeaders(accessToken),
          })
          
          if (itemOffersResponse.ok) {
            const itemOffersData = await itemOffersResponse.json()
            const itemOffers = itemOffersData.offers || []
            debugLog(`[INVENTORY] Found ${itemOffers.length} offer(s) for SKU ${itemSku}:`, itemOffers.map((o: any) => ({ id: o.offerId, status: o.status, listingId: o.listingId || o.listing?.listingId })))
            offers.push(...itemOffers)
          }
        }
        
        debugLog(`[INVENTORY] Total offers found by UPC: ${offers.length}`)
        debugLog(`[INVENTORY] Offer statuses:`, offers.map((o: any) => ({ id: o.offerId, status: o.status, listingId: o.listingId || o.listing?.listingId })))
        
        // Now find published offer from all offers
        offer = offers.find((o: any) => o.status === "PUBLISHED" && o.listing?.listingId)
        if (!offer) {
          offer = offers.find((o: any) => o.status === "PUBLISHED")
        }
        
        if (offer) {
          debugLog(`[INVENTORY] ✅ Found published offer by UPC search:`, { id: offer.offerId, status: offer.status, listingId: offer.listingId || offer.listing?.listingId })
        } else {
          console.warn(`[INVENTORY] ⚠️ No published offer found in ${offers.length} offers found by UPC`)
        }
      }
    }
    
    // CRITICAL: Only proceed if we found a PUBLISHED offer
    // We should NOT update unpublished offers when there's already a published listing
    if (!offer) {
      return NextResponse.json(
        { 
          error: "No published listing found for this product. The item may not be currently listed on eBay, or there may be an unpublished draft. Please list the item first before increasing inventory.",
          hint: "If you see a duplicate notice, the published listing exists but we couldn't find it. Try refreshing and checking your eBay listings."
        },
        { status: 404 }
      )
    }
    
    const offerId = offer.offerId
    const offerStatus = offer.status
    const listingId = offer.listingId || offer.listing?.listingId
    
    debugLog(`[INVENTORY] Selected offer - ID: ${offerId}, Status: ${offerStatus}, Listing ID: ${listingId}`)
    
    if (!offerId) {
      return NextResponse.json(
        { error: "Offer ID not found" },
        { status: 404 }
      )
    }
    
    // Double-check: Only proceed if offer is PUBLISHED
    if (offerStatus !== "PUBLISHED") {
      console.error(`[INVENTORY] ❌ Selected offer is not published (status: ${offerStatus}). Cannot update unpublished offers.`)
      return NextResponse.json(
        { 
          error: `Cannot increase inventory for unpublished offer. The offer status is "${offerStatus}". Only published listings can have their inventory increased.`,
          hint: "Please ensure the item is published on eBay before trying to increase inventory."
        },
        { status: 400 }
      )
    }

    // Get the current offer details to preserve all fields
    const getOfferUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}`
    const getOfferResponse = await fetch(getOfferUrl, {
      headers: ebayHeaders(accessToken),
    })

    if (!getOfferResponse.ok) {
      const { errorData } = await readErrorBody(getOfferResponse)
      return NextResponse.json(
        { error: `Failed to get offer details: ${getOfferResponse.status}`, details: errorData },
        { status: getOfferResponse.status }
      )
    }

    const currentOffer = await getOfferResponse.json()
    
    // Determine the canonical current quantity from eBay
    // Prefer the inventory item's shipToLocationAvailability.quantity (source of truth),
    // fall back to the offer's availableQuantity if inventory item is not available.
    let currentQuantity =
      typeof currentOffer.availableQuantity === "number"
        ? currentOffer.availableQuantity
        : 0
    let quantitySource: "offer" | "inventory_item" = "offer"

    try {
      const offerSkuForQuantity = currentOffer.sku
      if (offerSkuForQuantity) {
        const inventoryItemUrlForQuantity = `${baseUrl}/sell/inventory/v1/inventory_item/${offerSkuForQuantity}`
        const inventoryItemResponseForQuantity = await fetch(inventoryItemUrlForQuantity, {
          headers: ebayHeaders(accessToken),
        })

        if (inventoryItemResponseForQuantity.ok) {
          const inventoryItemForQuantity = await inventoryItemResponseForQuantity.json()
          const inventoryQty =
            inventoryItemForQuantity.availability?.shipToLocationAvailability?.quantity
          if (typeof inventoryQty === "number") {
            currentQuantity = inventoryQty
            quantitySource = "inventory_item"
          }
        }
      }
    } catch (qtyError) {
      console.warn("[INVENTORY] Could not fetch inventory item for canonical quantity:", qtyError)
    }

    // Sanitize current quantity
    if (!Number.isFinite(currentQuantity) || currentQuantity < 0) {
      currentQuantity = 0
    }

    const newQuantity = currentQuantity + 1

    debugLog(`[INVENTORY] Current quantity (${quantitySource}): ${currentQuantity}, New quantity: ${newQuantity}`)
    debugLog(`[INVENTORY] Offer status: ${offerStatus}, Listing ID: ${listingId}`)
    debugLog(`[INVENTORY] Current offer structure:`, JSON.stringify(currentOffer, null, 2))
    
    // For published offers, we might also need to update the inventory item
    // But first, let's try updating the offer and see if that works

    // Build update payload with only the fields that can be updated
    // eBay requires specific fields for offer updates - must match the structure from GET
    // IMPORTANT: listingDescription must be between 1-500000 characters (cannot be empty)
    let listingDescription = currentOffer.listingDescription?.trim() || "No description provided."
    
    // Validate listingDescription length (eBay requires 1-500000 characters)
    if (listingDescription.length === 0 || listingDescription.length > 500000) {
      console.error(`[INVENTORY] Invalid listingDescription length: ${listingDescription.length}. Using fallback.`)
      // Use a safe default that meets eBay's requirements
      listingDescription = "Product listing."
    }
    
    // Log if we had to use a fallback description
    if (!currentOffer.listingDescription?.trim()) {
      debugLog(`[INVENTORY] ⚠️ Offer had empty listingDescription, using fallback: "${listingDescription}"`)
    }
    
    const updatePayload: any = {
      sku: currentOffer.sku,
      marketplaceId: currentOffer.marketplaceId || "EBAY_US",
      format: currentOffer.format || "FIXED_PRICE",
      availableQuantity: newQuantity,
      listingDescription: listingDescription, // Ensure it's never empty (eBay requires 1-500000 chars)
      listingDuration: currentOffer.listingDuration || "GTC",
      pricingSummary: currentOffer.pricingSummary,
      categoryId: currentOffer.categoryId,
    }

    // Add optional fields only if they exist in the original offer
    if (currentOffer.includeCatalogProductDetails !== undefined) {
      updatePayload.includeCatalogProductDetails = currentOffer.includeCatalogProductDetails
    }

    // Add listing policies if they exist
    if (currentOffer.listingPolicies) {
      updatePayload.listingPolicies = currentOffer.listingPolicies
    }

    // Add merchant location key if it exists (required for publishing)
    if (currentOffer.merchantLocationKey) {
      updatePayload.merchantLocationKey = currentOffer.merchantLocationKey
    }

    // Add aspects if they exist
    if (currentOffer.product) {
      updatePayload.product = currentOffer.product
    }

    debugLog(`[INVENTORY] Update payload (keys only):`, Object.keys(updatePayload))
    debugLog(`[INVENTORY] Update payload (full):`, JSON.stringify(updatePayload, null, 2))

    const updateUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}`
    const updateResponse = await fetch(updateUrl, {
      method: "PUT",
      headers: ebayHeaders(accessToken),
      body: JSON.stringify(updatePayload),
    })

    if (!updateResponse.ok) {
      const { errorData, errorText } = await readErrorBody(updateResponse)
      console.error(`[INVENTORY] Failed to update offer:`, updateResponse.status, errorData, errorText)
      return NextResponse.json(
        { error: `Failed to update inventory: ${updateResponse.status}`, details: errorData },
        { status: updateResponse.status }
      )
    }

    // eBay returns 204 No Content on successful update, so no JSON to parse
    debugLog(`[INVENTORY] ✅ Offer update successful (status: ${updateResponse.status})`)
    
    // Verify the update was successful by fetching the updated offer
    const verifyResponse = await fetch(getOfferUrl, {
      headers: ebayHeaders(accessToken),
    })
    
    if (verifyResponse.ok) {
      const verifiedOffer = await verifyResponse.json()
      const verifiedQuantity = verifiedOffer.availableQuantity
      debugLog(`[INVENTORY] Verified offer quantity after update:`, verifiedQuantity)
      if (verifiedQuantity !== newQuantity) {
        console.warn(`[INVENTORY] ⚠️ WARNING: Quantity mismatch! Expected ${newQuantity}, got ${verifiedQuantity}`)
        // Still continue to publish, but note the discrepancy
      } else {
        debugLog(`[INVENTORY] ✅ Quantity verified: ${verifiedQuantity}`)
      }
    } else {
      console.warn(`[INVENTORY] ⚠️ Could not verify update (status: ${verifyResponse.status})`)
    }

    // For published offers, we need to update the inventory item's availability
    // This is the source of truth and should sync to both offer and listing
    const activeListingId = listingId || currentOffer.listing?.listingId
    const offerSku = currentOffer.sku
    
    if (offerStatus === "PUBLISHED" || activeListingId || currentOffer.listing?.listingStatus === "ACTIVE") {
      debugLog(`[INVENTORY] Offer is published (Listing ID: ${activeListingId}, SKU: ${offerSku}). Updating inventory item availability...`)
      
      // KEY INSIGHT: For Inventory API listings, we need to update the inventory item's
      // shipToLocationAvailability.quantity, which is the source of truth.
      // This should sync to both the offer and the live listing.
      try {
        const inventoryItemUrl = `${baseUrl}/sell/inventory/v1/inventory_item/${offerSku}`
        
        // First, get the current inventory item to preserve all fields
        const getInventoryItemResponse = await fetch(inventoryItemUrl, {
          headers: ebayHeaders(accessToken),
        })
        
        if (getInventoryItemResponse.ok) {
          const inventoryItem = await getInventoryItemResponse.json()
          debugLog(`[INVENTORY] Current inventory item quantity: ${inventoryItem.availability?.shipToLocationAvailability?.quantity || 'N/A'}`)
          
          // Update the inventory item with new quantity
          const updatedInventoryItem = {
            ...inventoryItem,
            availability: {
              ...inventoryItem.availability,
              shipToLocationAvailability: {
                ...inventoryItem.availability?.shipToLocationAvailability,
                quantity: newQuantity
              }
            }
          }
          
          debugLog(`[INVENTORY] Updating inventory item availability to quantity: ${newQuantity}`)
          
          const updateInventoryItemResponse = await fetch(inventoryItemUrl, {
            method: "PUT",
            headers: ebayHeaders(accessToken),
            body: JSON.stringify(updatedInventoryItem),
          })
          
          if (updateInventoryItemResponse.ok) {
            debugLog(`[INVENTORY] ✅ Inventory item availability updated successfully (status: ${updateInventoryItemResponse.status})`)
            
            // Verify the update
            const verifyInventoryResponse = await fetch(inventoryItemUrl, {
              headers: ebayHeaders(accessToken),
            })
            
            if (verifyInventoryResponse.ok) {
              const verifiedItem = await verifyInventoryResponse.json()
              const verifiedQty = verifiedItem.availability?.shipToLocationAvailability?.quantity
              debugLog(`[INVENTORY] Verified inventory item quantity: ${verifiedQty}`)
              
              if (verifiedQty === newQuantity) {
                // Success! The inventory item is updated, which should sync to the listing
                return NextResponse.json({
                  success: true,
                  newQuantity: newQuantity,
                  message: `Inventory increased successfully! Quantity updated to ${newQuantity}. Changes should appear on your eBay listing within 1-2 minutes.`,
                  listingId: activeListingId || null,
                  method: "inventory_item_update"
                })
              }
            }
          } else {
            const { errorData, errorText } = await readErrorBody(updateInventoryItemResponse)
            console.error(`[INVENTORY] Failed to update inventory item:`, updateInventoryItemResponse.status, errorData, errorText)
          }
        } else {
          console.warn(`[INVENTORY] Could not fetch inventory item for update (status: ${getInventoryItemResponse.status})`)
        }
      } catch (invError) {
        console.error(`[INVENTORY] Error updating inventory item:`, invError)
      }
      
      // Fallback: Try Trading API if inventory item update didn't work
      // (though it will likely fail for Inventory API listings)
      if (activeListingId) {
        debugLog(`[INVENTORY] Attempting fallback update via Trading API with Listing ID (ItemID): ${activeListingId}`)
        const tradingResult = await updateViaTradingAPI(
          accessToken,
          activeListingId,
          sku || currentOffer.sku,
          newQuantity,
          isSandbox
        )
        
        if (tradingResult.success) {
          return NextResponse.json({
            success: true,
            newQuantity: newQuantity,
            message: `Inventory increased successfully! Quantity updated to ${newQuantity} on your eBay listing.`,
            listingId: activeListingId,
            method: "trading_api"
          })
        } else {
          debugLog(`[INVENTORY] Trading API update also failed: ${tradingResult.error}`)
        }
      }
      
      // Fallback: Try Inventory API's bulk update endpoint (though it often fails)
      // The endpoint is: /sell/inventory/v1/bulk_update_price_quantity
      const bulkUpdateUrl = `${baseUrl}/sell/inventory/v1/bulk_update_price_quantity`
      
      // Get current price from the offer
      const currentPrice = currentOffer.pricingSummary?.price?.value || 
                          currentOffer.pricingSummary?.price || 
                          "0.00"
      const currency = currentOffer.pricingSummary?.price?.currency || "USD"
      
      // Try using offerId first, but also prepare SKU as fallback
      const bulkUpdatePayload = {
        requests: [{
          offerId: offerId,
          availableQuantity: newQuantity,
          // Price is required - keep the same price, only update quantity
          price: {
            value: String(currentPrice),
            currency: currency
          }
        }]
      }
      
      // Also try with SKU if offerId doesn't work (some listings might need SKU)
      const bulkUpdatePayloadWithSku = {
        requests: [{
          sku: offerSku,
          availableQuantity: newQuantity,
          price: {
            value: String(currentPrice),
            currency: currency
          }
        }]
      }
      
      debugLog(`[INVENTORY] Bulk update payload (with offerId):`, JSON.stringify(bulkUpdatePayload, null, 2))
      
      // Try with offerId first
      let bulkUpdateResponse = await fetch(bulkUpdateUrl, {
        method: "POST",
        headers: ebayHeaders(accessToken),
        body: JSON.stringify(bulkUpdatePayload),
      })
      
      // If that fails, try with SKU instead
      if (!bulkUpdateResponse.ok) {
        const errorText = await bulkUpdateResponse.text().catch(() => "")
        debugLog(`[INVENTORY] Bulk update with offerId failed, trying with SKU...`)
        debugLog(`[INVENTORY] Bulk update payload (with SKU):`, JSON.stringify(bulkUpdatePayloadWithSku, null, 2))
        
        bulkUpdateResponse = await fetch(bulkUpdateUrl, {
          method: "POST",
          headers: ebayHeaders(accessToken),
          body: JSON.stringify(bulkUpdatePayloadWithSku),
        })
      }
      
      if (!bulkUpdateResponse.ok) {
        const { errorData, errorText } = await readErrorBody(bulkUpdateResponse)
        console.error(`[INVENTORY] Failed to update live listing quantity via Inventory API:`, bulkUpdateResponse.status, errorData, errorText)
        
        // Log detailed error information
        if (errorData.responses && errorData.responses.length > 0) {
          errorData.responses.forEach((resp: any, idx: number) => {
            console.error(`[INVENTORY] Response ${idx} errors:`, JSON.stringify(resp.errors || [], null, 2))
            if (resp.errors && resp.errors.length > 0) {
              resp.errors.forEach((err: any) => {
                console.error(`[INVENTORY] Error ${err.errorId || 'unknown'}: ${err.message || err.longMessage || 'Unknown error'}`)
              })
            }
          })
        }
        
        // Check if this is an "Inventory API not supported" error or any 400 error
        // This happens when the listing was created via Trading API or eBay Seller Hub
        // OR when the bulk update endpoint doesn't work for this listing type
        const isInventoryApiNotSupported = 
          errorText.includes("not currently supported") ||
          errorText.includes("not supported") ||
          errorData?.errors?.some((e: any) => 
            e.message?.includes("not supported") || 
            e.errorId === 25710 || // Inventory-based listing management not supported
            e.errorId === 25002   // Invalid listing
          )
        
        // If bulk update fails (400 error) OR inventory API not supported, try Trading API
        // The listing ID (ItemID) should work with Trading API's ReviseItem
        if ((isInventoryApiNotSupported || bulkUpdateResponse.status === 400) && activeListingId) {
          debugLog(`[INVENTORY] Bulk update failed or not supported. Trying Trading API with Listing ID (ItemID): ${activeListingId}...`)
          
          // Use Trading API's ReviseItem with the actual listing ID (ItemID)
          const tradingResult = await updateViaTradingAPI(
            accessToken,
            activeListingId, // This is the ItemID (listing ID) from eBay
            sku || currentOffer.sku,
            newQuantity,
            isSandbox
          )
          
          if (tradingResult.success) {
            return NextResponse.json({
              success: true,
              newQuantity: newQuantity,
              message: `Inventory increased successfully! Quantity updated to ${newQuantity} on your eBay listing (via Trading API).`,
              listingId: activeListingId,
              method: "trading_api"
            })
          } else {
            // Trading API also failed
            return NextResponse.json({
              success: false,
              error: `Failed to update quantity. This listing may have restrictions. Error: ${tradingResult.error}`,
              listingId: activeListingId,
              inventoryApiError: errorData,
              tradingApiError: tradingResult.details
            }, { status: 400 })
          }
        }
        
        // If bulk update fails for other reasons, still return success for the offer update
        // but warn the user that the live listing might not be updated
        return NextResponse.json({
          success: true,
          newQuantity: newQuantity,
          warning: `Offer quantity updated to ${newQuantity}, but failed to update live listing. Error: ${bulkUpdateResponse.status}`,
          listingId: activeListingId || null,
          details: errorData
        })
      }
      
      const bulkUpdateResult = await bulkUpdateResponse.json().catch(() => ({}))
      
      // Check if the bulk update response contains errors for any of the items
      const responses = bulkUpdateResult.responses || []
      const hasErrors = responses.some((r: any) => r.errors && r.errors.length > 0)
      
      if (hasErrors) {
        const errors = responses.flatMap((r: any) => r.errors || [])
        console.error(`[INVENTORY] Bulk update returned errors:`, errors)
        
        // Check if this is an "Inventory API not supported" error
        const isInventoryApiNotSupported = errors.some((e: any) => 
          e.message?.includes("not supported") || 
          e.errorId === 25710 ||
          e.errorId === 25002
        )
        
        if (isInventoryApiNotSupported && activeListingId) {
          debugLog(`[INVENTORY] Inventory API not supported (from response). Trying Trading API...`)
          
          const tradingResult = await updateViaTradingAPI(
            accessToken,
            activeListingId,
            sku || currentOffer.sku,
            newQuantity,
            isSandbox
          )
          
          if (tradingResult.success) {
            return NextResponse.json({
              success: true,
              newQuantity: newQuantity,
              message: `Inventory increased successfully! Quantity updated to ${newQuantity} on your eBay listing (via Trading API).`,
              listingId: activeListingId,
              method: "trading_api"
            })
          }
        }
        
        return NextResponse.json({
          success: false,
          error: `Failed to update live listing quantity: ${errors[0]?.message || 'Unknown error'}`,
          listingId: activeListingId || null,
          details: errors
        }, { status: 400 })
      }
      
      debugLog(`[INVENTORY] ✅ Live listing quantity updated successfully:`, bulkUpdateResult)
      
      return NextResponse.json({
        success: true,
        newQuantity: newQuantity,
        message: `Inventory increased successfully! Quantity updated from ${currentQuantity} to ${newQuantity} on your eBay listing.`,
        listingId: activeListingId || null,
        bulkUpdateResult: bulkUpdateResult
      })
    }

    // Only publish if the offer is not already published
    const publishUrl = `${baseUrl}/sell/inventory/v1/offer/${offerId}/publish`
    debugLog(`[INVENTORY] Publishing offer (status was: ${offerStatus})`)
    const publishResponse = await fetch(publishUrl, {
      method: "POST",
      headers: ebayHeaders(accessToken),
    })

    if (!publishResponse.ok) {
      const { errorData } = await readErrorBody(publishResponse)
      console.error(`[INVENTORY] Failed to publish offer:`, publishResponse.status, errorData)
      // Even if publish fails, the quantity was updated
      return NextResponse.json(
        { 
          success: true,
          newQuantity: newQuantity,
          warning: "Inventory updated but failed to publish. You may need to publish manually.",
          details: errorData 
        },
        { status: 200 }
      )
    }

    const publishResult = await publishResponse.json().catch(() => ({}))
    debugLog(`[INVENTORY] Publish response:`, publishResult)
    debugLog(`[INVENTORY] ✅ Successfully increased inventory to ${newQuantity} and published`)

    return NextResponse.json({
      success: true,
      newQuantity: newQuantity,
      message: "Inventory increased and published successfully",
      listingId: publishResult.listingId || null
    })

  } catch (error) {
    console.error("Error increasing inventory:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

