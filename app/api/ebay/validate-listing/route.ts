import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import {
  readErrorBody,
  getEbayBaseUrl,
  getValidEbayToken,
  ebayHeaders,
} from "@/lib/ebay"

/**
 * GET: Validate listing requirements before attempting to list
 * Checks required item specifics for the category
 */
export async function GET(req: Request) {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(req.url)
    const categoryId = searchParams.get("categoryId")
    const aspects = searchParams.get("aspects") // JSON string of current aspects

    if (!categoryId) {
      return NextResponse.json(
        { error: "Category ID is required" },
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

    // Fetch required item aspects for this category using Taxonomy API
    const baseUrl = getEbayBaseUrl()
    
    const taxonomyUrl = `${baseUrl}/sell/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`
    
    console.log("Fetching required aspects for category:", categoryId)
    
    const taxonomyResponse = await fetch(taxonomyUrl, {
      headers: ebayHeaders(accessToken),
    })

    if (!taxonomyResponse.ok) {
      const { errorData } = await readErrorBody(taxonomyResponse)
      console.error("Taxonomy API error:", errorData)
      
      // If taxonomy API fails, return what we can
      return NextResponse.json({
        valid: false,
        error: "Could not fetch category requirements",
        details: errorData,
        // Still return empty arrays so frontend can proceed
        requiredAspects: [],
        missingAspects: [],
        currentAspects: {}
      })
    }

    const taxonomyData = await taxonomyResponse.json()
    
    // Parse current aspects if provided
    let currentAspects: any = {}
    try {
      if (aspects) {
        currentAspects = JSON.parse(aspects)
      }
    } catch (e) {
      console.warn("Could not parse aspects:", e)
    }

    // Extract required aspects from taxonomy response
    const requiredAspects: string[] = []
    const aspectDefinitions = taxonomyData.aspects || []
    
    aspectDefinitions.forEach((aspect: any) => {
      // Check if aspect is required
      if (aspect.aspectConstraint?.aspectRequired === true) {
        requiredAspects.push(aspect.localizedAspectName || aspect.aspectName)
      }
    })

    // Check which required aspects are missing
    const missingAspects: string[] = []
    const aspectKeys = Object.keys(currentAspects).map(k => k.toLowerCase())
    
    requiredAspects.forEach((requiredAspect: string) => {
      const aspectKey = requiredAspect.toLowerCase()
      const hasAspect = aspectKeys.some(key => 
        key === aspectKey || 
        key.includes(aspectKey) || 
        aspectKey.includes(key)
      )
      
      if (!hasAspect) {
        missingAspects.push(requiredAspect)
      }
    })

    // Also check if aspects have values (not just keys)
    Object.keys(currentAspects).forEach((key: string) => {
      const values = currentAspects[key]
      if (Array.isArray(values) && values.length === 0) {
        const requiredKey = requiredAspects.find(req => 
          req.toLowerCase() === key.toLowerCase()
        )
        if (requiredKey && !missingAspects.includes(requiredKey)) {
          missingAspects.push(requiredKey)
        }
      }
    })

    console.log("Validation results:", {
      categoryId,
      requiredAspects,
      missingAspects,
      currentAspectKeys: Object.keys(currentAspects)
    })

    return NextResponse.json({
      valid: missingAspects.length === 0,
      categoryId,
      requiredAspects,
      missingAspects,
      currentAspects,
      aspectDefinitions: aspectDefinitions.map((a: any) => ({
        name: a.localizedAspectName || a.aspectName,
        required: a.aspectConstraint?.aspectRequired === true,
        values: a.aspectValues?.map((v: any) => v.localizedValue || v.value) || []
      }))
    })
  } catch (error) {
    console.error("Error validating listing:", error)
    return NextResponse.json(
      { 
        error: "Failed to validate listing requirements",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

