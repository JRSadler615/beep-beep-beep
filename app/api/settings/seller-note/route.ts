import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

const DEFAULT_SELLER_NOTE =
  "Please note: any mention of a digital copy or code may be expired and/or unavailable. This does not affect the quality or functionality of the DVD."

// GET: Fetch current seller note editing setting for the user
export async function GET() {
  try {
    const session = await auth()

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    let settings = await prisma.sellerNoteSettings.findUnique({
      where: { userId: session.user.id },
    })

    // Create default settings if missing
    if (!settings) {
      settings = await prisma.sellerNoteSettings.create({
        data: {
          userId: session.user.id,
          enableSellerNoteEditing: false,
          sellerNoteText: DEFAULT_SELLER_NOTE,
        },
      })
    }

    return NextResponse.json({
      enableSellerNoteEditing: settings.enableSellerNoteEditing,
      sellerNoteText: settings.sellerNoteText || DEFAULT_SELLER_NOTE,
    })
  } catch (error) {
    console.error("Error fetching seller note settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch seller note settings" },
      { status: 500 }
    )
  }
}

// POST: Update universal seller note settings
export async function POST(req: Request) {
  try {
    const session = await auth()

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await req.json()
    const { enableSellerNoteEditing, sellerNoteText } = body

    if (enableSellerNoteEditing !== undefined && typeof enableSellerNoteEditing !== "boolean") {
      return NextResponse.json(
        { error: "enableSellerNoteEditing must be a boolean value" },
        { status: 400 }
      )
    }

    if (sellerNoteText !== undefined && typeof sellerNoteText !== "string") {
      return NextResponse.json(
        { error: "sellerNoteText must be a string value" },
        { status: 400 }
      )
    }

    const sanitizedSellerNoteText =
      sellerNoteText !== undefined
        ? (sellerNoteText.trim().length > 0 ? sellerNoteText.trim() : DEFAULT_SELLER_NOTE)
        : undefined

    const updated = await prisma.sellerNoteSettings.upsert({
      where: { userId: session.user.id },
      update: {
        ...(enableSellerNoteEditing !== undefined && { enableSellerNoteEditing }),
        ...(sanitizedSellerNoteText !== undefined && { sellerNoteText: sanitizedSellerNoteText }),
      },
      create: {
        userId: session.user.id,
        enableSellerNoteEditing: enableSellerNoteEditing !== undefined ? enableSellerNoteEditing : false,
        sellerNoteText: sanitizedSellerNoteText || DEFAULT_SELLER_NOTE,
      },
    })

    return NextResponse.json({
      success: true,
      enableSellerNoteEditing: updated.enableSellerNoteEditing,
      sellerNoteText: updated.sellerNoteText || DEFAULT_SELLER_NOTE,
    })
  } catch (error) {
    console.error("Error updating seller note settings:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update seller note settings", details: errorMessage },
      { status: 500 }
    )
  }
}

