import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// POST: Update initial SKU counter
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
    const { initialSku } = body

    if (!initialSku) {
      return NextResponse.json(
        { error: "Initial SKU is required" },
        { status: 400 }
      )
    }

    const counter = parseInt(initialSku)
    if (isNaN(counter) || counter < 1) {
      return NextResponse.json(
        { error: "Initial SKU must be a positive integer" },
        { status: 400 }
      )
    }

    // Update or create SKU settings
    const updated = await prisma.skuSettings.upsert({
      where: { userId: session.user.id },
      update: {
        nextSkuCounter: counter,
      },
      create: {
        userId: session.user.id,
        nextSkuCounter: counter,
        skuPrefix: null,
      }
    })

    return NextResponse.json({
      success: true,
      message: "SKU configured successfully",
      nextSkuCounter: updated.nextSkuCounter,
    })
  } catch (error) {
    console.error("Error updating SKU counter:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update SKU counter", details: errorMessage },
      { status: 500 }
    )
  }
}

