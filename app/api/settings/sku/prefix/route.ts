import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// POST: Update SKU prefix
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
    const { prefix } = body

    // Prefix is optional - if empty string or null, clear it (use auto-detection)
    const prefixValue = prefix && prefix.trim() !== "" ? prefix.trim() : null

    // Update or create SKU settings
    const updated = await prisma.skuSettings.upsert({
      where: { userId: session.user.id },
      update: {
        skuPrefix: prefixValue,
      },
      create: {
        userId: session.user.id,
        nextSkuCounter: 1,
        skuPrefix: prefixValue,
      }
    })

    return NextResponse.json({
      success: true,
      message: "Prefix configured successfully",
      skuPrefix: updated.skuPrefix,
    })
  } catch (error) {
    console.error("Error updating SKU prefix:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update SKU prefix", details: errorMessage },
      { status: 500 }
    )
  }
}

