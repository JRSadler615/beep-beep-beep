import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET: Fetch current SKU settings for the user
export async function GET() {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Get or create SKU settings for the user
    let skuSettings = await prisma.skuSettings.findUnique({
      where: { userId: session.user.id }
    })

    // If no settings exist, create default ones
    if (!skuSettings) {
      skuSettings = await prisma.skuSettings.create({
        data: {
          userId: session.user.id,
          nextSkuCounter: 1,
          skuPrefix: null,
        }
      })
    }

    return NextResponse.json({
      nextSkuCounter: skuSettings.nextSkuCounter,
      skuPrefix: skuSettings.skuPrefix,
    })
  } catch (error) {
    console.error("Error fetching SKU settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch SKU settings" },
      { status: 500 }
    )
  }
}

// POST: Update SKU settings
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
    const { nextSkuCounter, skuPrefix } = body

    // Validate nextSkuCounter if provided
    if (nextSkuCounter !== undefined) {
      const counter = parseInt(nextSkuCounter)
      if (isNaN(counter) || counter < 1) {
        return NextResponse.json(
          { error: "SKU counter must be a positive integer" },
          { status: 400 }
        )
      }
    }

    // Validate skuPrefix if provided (optional, can be null)
    if (skuPrefix !== undefined && skuPrefix !== null && skuPrefix.trim() === "") {
      // Empty string means clear the prefix (use auto-detection)
      const updated = await prisma.skuSettings.upsert({
        where: { userId: session.user.id },
        update: {
          ...(nextSkuCounter !== undefined && { nextSkuCounter: parseInt(nextSkuCounter) }),
          skuPrefix: null,
        },
        create: {
          userId: session.user.id,
          nextSkuCounter: nextSkuCounter !== undefined ? parseInt(nextSkuCounter) : 1,
          skuPrefix: null,
        }
      })

      return NextResponse.json({
        success: true,
        nextSkuCounter: updated.nextSkuCounter,
        skuPrefix: updated.skuPrefix,
      })
    }

    // Update settings
    const updated = await prisma.skuSettings.upsert({
      where: { userId: session.user.id },
      update: {
        ...(nextSkuCounter !== undefined && { nextSkuCounter: parseInt(nextSkuCounter) }),
        ...(skuPrefix !== undefined && { skuPrefix: skuPrefix || null }),
      },
      create: {
        userId: session.user.id,
        nextSkuCounter: nextSkuCounter !== undefined ? parseInt(nextSkuCounter) : 1,
        skuPrefix: skuPrefix || null,
      }
    })

    return NextResponse.json({
      success: true,
      nextSkuCounter: updated.nextSkuCounter,
      skuPrefix: updated.skuPrefix,
    })
  } catch (error) {
    console.error("Error updating SKU settings:", error)
    return NextResponse.json(
      { error: "Failed to update SKU settings" },
      { status: 500 }
    )
  }
}

