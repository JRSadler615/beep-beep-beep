import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import {
  readErrorBody,
  getEbayBaseUrl,
  getValidEbayToken,
  debugLog,
} from "@/lib/ebay"

// Helper function to extract image size from eBay URL
// Returns the size in pixels, or 0 if unknown
function getImageSizeFromUrl(imageUrl: string | undefined): number {
  if (!imageUrl) return 0
  
  // Extract size from URL pattern: /s-l640.jpg -> 640
  const match = imageUrl.match(/\/s-l(\d+)\.jpg/i)
  if (match && match[1]) {
    return parseInt(match[1], 10)
  }
  
  // If no size parameter, assume it might be full resolution (but we can't be sure)
  // Return a safe value that indicates "unknown but potentially OK"
  return 999
}

// Helper function to convert eBay image URLs to higher resolution
// eBay image URLs often have size parameters like /s-l640.jpg
// We'll try to get larger versions, but if conversion fails, return null to trigger fallback
function getHighResImageUrl(imageUrl: string | undefined): { url: string; isHighRes: boolean } | null {
  if (!imageUrl) return null
  
  const currentSize = getImageSizeFromUrl(imageUrl)
  
  // If image is already 1200px or larger, it definitely meets eBay's 500px requirement
  // Use it as-is to avoid potential 404 errors from non-existent high-res URLs
  if (currentSize >= 1200) {
    debugLog(`[IMAGE RESIZE] Image already ${currentSize}px (>= 1200px), using as-is: ${imageUrl}`)
    return { url: imageUrl, isHighRes: true }
  }
  
  // If image is > 640px, it should work with eBay (we fall back for 640px in main logic)
  // Use it as-is - don't try to convert URLs as the converted URLs might not exist
  // eBay will check actual image dimensions, not just the URL
  if (currentSize > 640) {
    debugLog(`[IMAGE RESIZE] Image already ${currentSize}px (> 640px, should work with eBay), using as-is: ${imageUrl}`)
    return { url: imageUrl, isHighRes: true }
  }
  
  // If image is exactly 640px, return as-is but mark as potentially problematic
  // The main logic will handle falling back to seller images for 640px
  if (currentSize === 640) {
    debugLog(`[IMAGE RESIZE] Image is 640px (eBay rejects these in practice), returning as-is: ${imageUrl}`)
    return { url: imageUrl, isHighRes: false } // Mark as potentially problematic
  }
  
  // If image is 500-639px, it meets the requirement but might be borderline
  // Use as-is
  if (currentSize >= 500 && currentSize < 640) {
    debugLog(`[IMAGE RESIZE] Image is ${currentSize}px (>= 500px but < 640px), using as-is: ${imageUrl}`)
    return { url: imageUrl, isHighRes: true }
  }
  
  // If image is smaller than 500px, it doesn't meet eBay's requirement
  // Try to convert to at least 500px, but this might fail
  if (currentSize > 0 && currentSize < 500) {
    const highResUrl = imageUrl.replace(/\/s-l\d+\.jpg/i, '/s-l500.jpg')
    debugLog(`[IMAGE RESIZE] Upscaling small image ${currentSize}px -> 500px: ${imageUrl} -> ${highResUrl}`)
    return { url: highResUrl, isHighRes: false } // Mark as potentially unreliable
  }
  
  // If no size parameter detected, return as-is (might be full resolution)
  debugLog(`[IMAGE RESIZE] No size parameter detected, using as-is: ${imageUrl}`)
  return { url: imageUrl, isHighRes: true }
}

// Helper function to process image object and get high-res URL
// Returns the image object with high-res URL, or null if conversion failed
function getHighResImage(image: any): any | null {
  if (!image || !image.imageUrl) return image
  
  const result = getHighResImageUrl(image.imageUrl)
  if (result) {
    return {
      ...image,
      imageUrl: result.url
    }
  }
  
  // If conversion failed, return null to trigger fallback
  return null
}

export async function GET(req: Request) {
  try {
    // Check if user is authenticated
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(req.url)
    const upc = searchParams.get("upc")

    if (!upc) {
      return NextResponse.json(
        { error: "UPC code is required" },
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

    // Make request to eBay Browse API
    const browseApiUrl = `${getEbayBaseUrl()}/buy/browse/v1/item_summary/search`

    const ebayResponse = await fetch(
      `${browseApiUrl}?q=${encodeURIComponent(upc)}&fieldgroups=EXTENDED`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', // You can make this configurable
        }
      }
    )
    
    if (!ebayResponse.ok) {
      const { errorData } = await readErrorBody(ebayResponse)
      
      return NextResponse.json(
        { 
          error: errorData.errors?.[0]?.message || "Failed to search eBay",
          details: errorData
        },
        { status: ebayResponse.status }
      )
    }

    const data = await ebayResponse.json()
    
    // Check if we have any products
    if (!data.itemSummaries || data.itemSummaries.length === 0) {
      return NextResponse.json(
        { error: "No products found for this UPC code" },
        { status: 404 }
      )
    }
    
    // Get first 10 items for mean price calculation
    const itemsForMean = data.itemSummaries.slice(0, 10)
    
    // Calculate mean price from first 10 items (filter out items without valid prices)
    const prices = itemsForMean
      .filter((item: any) => item.price?.value)
      .map((item: any) => parseFloat(item.price.value))
    
    const meanPrice = prices.length > 0
      ? (prices.reduce((sum: number, price: number) => sum + price, 0) / prices.length).toFixed(2)
      : "0.00"
    
    // Select a RANDOM product from the search results
    const randomIndex = Math.floor(Math.random() * data.itemSummaries.length)
    const selectedProduct = data.itemSummaries[randomIndex]
    
    // Use the random product but replace its price with the mean price
    let product: any = {
      ...selectedProduct,
      price: {
        ...selectedProduct.price,
        value: meanPrice,
        currency: selectedProduct.price?.currency || "USD"
      }
    }

    // Try to enrich with eBay catalog (stock) images.
    // If this fails for any reason, we silently fall back to the existing
    // Browse API images (seller images), preserving legacy behaviour.
    
    // Preserve original seller images for reference/debugging
    const originalSellerImage = product.image
    const originalSellerAdditionalImages = product.additionalImages || []
    
    debugLog(`[IMAGE FETCH] UPC: ${upc} - Starting image fetch process`)
    debugLog(`[IMAGE FETCH] Seller image from Browse API:`, originalSellerImage?.imageUrl || "None")
    debugLog(`[IMAGE FETCH] Seller additional images:`, originalSellerAdditionalImages.length)
    
    try {
      const isSandbox = process.env.EBAY_SANDBOX === "true"
      const catalogApiUrl = isSandbox
        ? "https://api.sandbox.ebay.com/commerce/catalog/v1_beta/product_summary/search"
        : "https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search"

      debugLog(`[IMAGE FETCH] Attempting to fetch stock image from Catalog API...`)
      debugLog(`[IMAGE FETCH] Catalog API URL: ${catalogApiUrl}`)

      const catalogResponse = await fetch(
        `${catalogApiUrl}?q=${encodeURIComponent(upc)}&fieldgroups=FULL`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          },
        }
      )

      debugLog(`[IMAGE FETCH] Catalog API response status: ${catalogResponse.status} ${catalogResponse.statusText}`)

      if (catalogResponse.ok) {
        const catalogData = await catalogResponse.json().catch(() => ({} as any))
        const productSummaries = (catalogData as any).productSummaries

        debugLog(`[IMAGE FETCH] Catalog API returned ${productSummaries?.length || 0} product summaries`)

        if (Array.isArray(productSummaries) && productSummaries.length > 0) {
          const catalogProduct = productSummaries[0] as any
          const stockImage = catalogProduct.image
          const stockAdditionalImages = catalogProduct.additionalImages

          debugLog(`[IMAGE FETCH] Stock image from catalog:`, stockImage?.imageUrl || "None")
          debugLog(`[IMAGE FETCH] Stock additional images:`, stockAdditionalImages?.length || 0)

          if (stockImage?.imageUrl) {
            const stockImageSize = getImageSizeFromUrl(stockImage.imageUrl)
            debugLog(`[IMAGE FETCH] Stock image size from URL: ${stockImageSize}px`)
            
            // eBay requires at least 500px, but in practice they reject 640px images too
            // So we'll only use stock images if they're > 640px (e.g., 800px+)
            // For 640px stock images, fall back to seller images to avoid listing errors
            if (stockImageSize > 0 && stockImageSize <= 640) {
              debugLog(`[IMAGE FETCH] ⚠️ Stock image size ${stockImageSize}px (<= 640px), falling back to seller images`)
              debugLog(`[IMAGE FETCH] Note: eBay rejects 640px images in practice even though they meet 500px requirement`)
              
              // Use seller images since stock images are 640px or smaller (eBay rejects these)
              product.image = originalSellerImage
              product.additionalImages = originalSellerAdditionalImages
              
              product._imageSources = {
                stockImage: stockImage,
                stockImageOriginal: stockImage,
                stockAdditionalImages: stockAdditionalImages || [],
                stockAdditionalImagesOriginal: stockAdditionalImages || [],
                sellerImage: originalSellerImage,
                sellerAdditionalImages: originalSellerAdditionalImages || [],
                source: "seller_only_fallback_due_to_size",
              }
              
              debugLog(`[IMAGE FETCH] ✅ USING SELLER IMAGE (stock image ${stockImageSize}px <= 640px):`, originalSellerImage?.imageUrl || "None")
            } else {
              // Stock image is 500px+ or unknown size, try to use it
              // Convert to high-res if needed for better quality
              const highResStockImage = getHighResImage(stockImage)
              
              if (!highResStockImage) {
                // Conversion failed, use seller images
                debugLog(`[IMAGE FETCH] ⚠️ Failed to process stock image, falling back to seller images`)
                
                product.image = originalSellerImage
                product.additionalImages = originalSellerAdditionalImages
                
                product._imageSources = {
                  stockImage: stockImage,
                  stockImageOriginal: stockImage,
                  stockAdditionalImages: stockAdditionalImages || [],
                  stockAdditionalImagesOriginal: stockAdditionalImages || [],
                  sellerImage: originalSellerImage,
                  sellerAdditionalImages: originalSellerAdditionalImages || [],
                  source: "seller_only_fallback_conversion_failed",
                }
                
                debugLog(`[IMAGE FETCH] ✅ USING SELLER IMAGE (conversion failed):`, originalSellerImage?.imageUrl || "None")
              } else {
              // Stock image is good, convert additional images
              const highResStockAdditionalImages = Array.isArray(stockAdditionalImages)
                ? stockAdditionalImages
                    .map((img: any) => {
                      const imgUrl = typeof img === 'string' ? { imageUrl: img } : img
                      const converted = getHighResImage(imgUrl)
                      return converted || imgUrl // Use original if conversion fails
                    })
                    .filter((img: any) => {
                      // Filter out images that are 640px or smaller (eBay rejects these in practice)
                      const size = getImageSizeFromUrl(img.imageUrl)
                      return size === 0 || size > 640
                    })
                : []
              
              debugLog(`[IMAGE FETCH] High-res stock image:`, highResStockImage.imageUrl)
              debugLog(`[IMAGE FETCH] High-res stock additional images: ${highResStockAdditionalImages.length} (filtered from ${stockAdditionalImages?.length || 0})`)
              
              // Prefer stock image for primary display and listing.
              product.image = highResStockImage
              product.additionalImages =
                highResStockAdditionalImages.length > 0
                  ? highResStockAdditionalImages
                  : originalSellerAdditionalImages

              // Attach metadata so the frontend/debug view can see both sources.
              product._imageSources = {
                stockImage: highResStockImage, // Store high-res version
                stockImageOriginal: stockImage, // Store original for reference
                stockAdditionalImages: highResStockAdditionalImages,
                stockAdditionalImagesOriginal: stockAdditionalImages || [],
                sellerImage: originalSellerImage,
                sellerAdditionalImages: originalSellerAdditionalImages || [],
                source: "stock_preferred_with_seller_fallback",
              }
              
              debugLog(`[IMAGE FETCH] ✅ USING HIGH-RES STOCK IMAGE: ${highResStockImage.imageUrl}`)
              debugLog(`[IMAGE FETCH] Additional images: ${product.additionalImages.length} (${highResStockAdditionalImages.length > 0 ? 'high-res stock' : 'seller fallback'})`)
              }
            }
          } else {
            debugLog(`[IMAGE FETCH] ⚠️ Catalog API returned product but no stock image URL found`)
            // Set metadata to show we tried but no stock image available
            product._imageSources = {
              stockImage: null,
              stockAdditionalImages: [],
              sellerImage: originalSellerImage,
              sellerAdditionalImages: originalSellerAdditionalImages || [],
              source: "seller_only",
            }
            debugLog(`[IMAGE FETCH] ✅ USING SELLER IMAGE (no stock image available):`, originalSellerImage?.imageUrl || "None")
          }
        } else {
          debugLog(`[IMAGE FETCH] ⚠️ Catalog API returned no product summaries`)
          // Set metadata to show we tried but no products found
          product._imageSources = {
            stockImage: null,
            stockAdditionalImages: [],
            sellerImage: originalSellerImage,
            sellerAdditionalImages: originalSellerAdditionalImages || [],
            source: "seller_only",
          }
          debugLog(`[IMAGE FETCH] ✅ USING SELLER IMAGE (no catalog products found):`, originalSellerImage?.imageUrl || "None")
        }
      } else {
        const errorText = await catalogResponse.text().catch(() => "Unknown error")
        debugLog(`[IMAGE FETCH] ❌ Catalog API error: ${catalogResponse.status} - ${errorText.substring(0, 200)}`)
        // Set metadata to show catalog API failed
        product._imageSources = {
          stockImage: null,
          stockAdditionalImages: [],
          sellerImage: originalSellerImage,
          sellerAdditionalImages: originalSellerAdditionalImages || [],
          source: "seller_only",
        }
        debugLog(`[IMAGE FETCH] ✅ USING SELLER IMAGE (catalog API failed):`, originalSellerImage?.imageUrl || "None")
      }
    } catch (error) {
      debugLog(`[IMAGE FETCH] ❌ Exception while fetching stock image:`, error instanceof Error ? error.message : String(error))
      // Set metadata to show exception occurred
      product._imageSources = {
        stockImage: null,
        stockAdditionalImages: [],
        sellerImage: originalSellerImage,
        sellerAdditionalImages: originalSellerAdditionalImages || [],
        source: "seller_only",
      }
      debugLog(`[IMAGE FETCH] ✅ USING SELLER IMAGE (exception occurred):`, originalSellerImage?.imageUrl || "None")
    }
    
    debugLog(`[IMAGE FETCH] Final image source: ${product._imageSources?.source || "unknown"}`)
    debugLog(`[IMAGE FETCH] Final primary image URL: ${product.image?.imageUrl || "None"}`)
    
    // Add metadata about the search for debugging
    const responseData = {
      ...product,
      _searchMetadata: {
        totalResults: data.itemSummaries.length,
        selectedIndex: randomIndex,
        itemsUsedForMean: prices.length,
        isMeanPrice: true,
        originalPrice: selectedProduct.price?.value,
        meanPrice: meanPrice,
        searchQuery: upc
      }
    }

    return NextResponse.json(responseData)
  } catch (error) {
    return NextResponse.json(
      { error: "Something went wrong", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

