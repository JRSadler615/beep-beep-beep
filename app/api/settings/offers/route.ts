import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

const DEFAULT_MINIMUM_OFFER_AMOUNT = 10.0

export async function GET() {
  try {
    const session = await auth()

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    let offerSettings = await prisma.offerSettings.findUnique({
      where: { userId: session.user.id },
    })

    if (!offerSettings) {
      offerSettings = await prisma.offerSettings.create({
        data: {
          userId: session.user.id,
          allowOffers: false,
          minimumOfferAmount: DEFAULT_MINIMUM_OFFER_AMOUNT,
        },
      })
    }

    return NextResponse.json({
      allowOffers: offerSettings.allowOffers,
      minimumOfferAmount: offerSettings.minimumOfferAmount,
    })
  } catch (error) {
    console.error("Error fetching offer settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch offer settings" },
      { status: 500 }
    )
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth()

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await req.json()
    const { allowOffers, minimumOfferAmount } = body

    if (allowOffers !== undefined && typeof allowOffers !== "boolean") {
      return NextResponse.json(
        { error: "allowOffers must be a boolean value" },
        { status: 400 }
      )
    }

    if (minimumOfferAmount !== undefined) {
      const parsedMinimumOfferAmount = Number(minimumOfferAmount)
      if (Number.isNaN(parsedMinimumOfferAmount) || parsedMinimumOfferAmount <= 0) {
        return NextResponse.json(
          { error: "minimumOfferAmount must be a valid number greater than 0" },
          { status: 400 }
        )
      }
    }

    const updated = await prisma.offerSettings.upsert({
      where: { userId: session.user.id },
      update: {
        ...(allowOffers !== undefined && { allowOffers }),
        ...(minimumOfferAmount !== undefined && { minimumOfferAmount: Number(minimumOfferAmount) }),
      },
      create: {
        userId: session.user.id,
        allowOffers: allowOffers !== undefined ? allowOffers : false,
        minimumOfferAmount:
          minimumOfferAmount !== undefined
            ? Number(minimumOfferAmount)
            : DEFAULT_MINIMUM_OFFER_AMOUNT,
      },
    })

    return NextResponse.json({
      success: true,
      allowOffers: updated.allowOffers,
      minimumOfferAmount: updated.minimumOfferAmount,
    })
  } catch (error) {
    console.error("Error updating offer settings:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update offer settings", details: errorMessage },
      { status: 500 }
    )
  }
}

