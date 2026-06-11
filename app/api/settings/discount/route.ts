import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET: Fetch current discount settings for the user
export async function GET() {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Get or create discount settings for the user
    let discountSettings = await prisma.discountSettings.findUnique({
      where: { userId: session.user.id }
    })

    // If no settings exist, create default ones
    if (!discountSettings) {
      discountSettings = await prisma.discountSettings.create({
        data: {
          userId: session.user.id,
          discountAmount: 3.0,
          minimumPrice: 4.0,
        }
      })
    }

    return NextResponse.json({
      discountAmount: discountSettings.discountAmount,
      minimumPrice: discountSettings.minimumPrice,
    })
  } catch (error) {
    console.error("Error fetching discount settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch discount settings" },
      { status: 500 }
    )
  }
}

// POST: Update discount settings
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
    const { discountAmount, minimumPrice } = body

    // Validate discountAmount if provided
    if (discountAmount !== undefined) {
      const amount = parseFloat(discountAmount)
      if (isNaN(amount)) {
        return NextResponse.json(
          { error: "Discount amount must be a valid number" },
          { status: 400 }
        )
      }
      if (amount < 0) {
        return NextResponse.json(
          { error: "Discount amount cannot be negative" },
          { status: 400 }
        )
      }
    }

    // Validate minimumPrice if provided
    if (minimumPrice !== undefined) {
      const minPrice = parseFloat(minimumPrice)
      if (isNaN(minPrice)) {
        return NextResponse.json(
          { error: "Minimum price must be a valid number" },
          { status: 400 }
        )
      }
      if (minPrice < 0) {
        return NextResponse.json(
          { error: "Minimum price cannot be negative" },
          { status: 400 }
        )
      }
    }

    // Update or create settings
    const updated = await prisma.discountSettings.upsert({
      where: { userId: session.user.id },
      update: {
        ...(discountAmount !== undefined && { discountAmount: parseFloat(discountAmount) }),
        ...(minimumPrice !== undefined && { minimumPrice: parseFloat(minimumPrice) }),
      },
      create: {
        userId: session.user.id,
        discountAmount: discountAmount !== undefined ? parseFloat(discountAmount) : 3.0,
        minimumPrice: minimumPrice !== undefined ? parseFloat(minimumPrice) : 4.0,
      }
    })

    return NextResponse.json({
      success: true,
      discountAmount: updated.discountAmount,
      minimumPrice: updated.minimumPrice,
    })
  } catch (error) {
    console.error("Error updating discount settings:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update discount settings", details: errorMessage },
      { status: 500 }
    )
  }
}
