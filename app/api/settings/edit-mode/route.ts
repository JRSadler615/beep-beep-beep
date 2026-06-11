import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET: Fetch current edit mode setting for the user
export async function GET() {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Get or create edit mode settings for the user
    let editModeSettings = await prisma.editModeSettings.findUnique({
      where: { userId: session.user.id }
    })

    // If no settings exist, create default ones (defaultEditMode = false)
    if (!editModeSettings) {
      editModeSettings = await prisma.editModeSettings.create({
        data: {
          userId: session.user.id,
          defaultEditMode: false,
        }
      })
    }

    return NextResponse.json({
      defaultEditMode: editModeSettings.defaultEditMode,
    })
  } catch (error) {
    console.error("Error fetching edit mode settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch edit mode settings" },
      { status: 500 }
    )
  }
}

// POST: Update edit mode setting
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
    const { defaultEditMode } = body

    // Validate defaultEditMode if provided
    if (defaultEditMode !== undefined && typeof defaultEditMode !== "boolean") {
      return NextResponse.json(
        { error: "defaultEditMode must be a boolean value" },
        { status: 400 }
      )
    }

    // Update or create settings
    const updated = await prisma.editModeSettings.upsert({
      where: { userId: session.user.id },
      update: {
        ...(defaultEditMode !== undefined && { defaultEditMode }),
      },
      create: {
        userId: session.user.id,
        defaultEditMode: defaultEditMode !== undefined ? defaultEditMode : false,
      }
    })

    return NextResponse.json({
      success: true,
      defaultEditMode: updated.defaultEditMode,
    })
  } catch (error) {
    console.error("Error updating edit mode settings:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update edit mode settings", details: errorMessage },
      { status: 500 }
    )
  }
}

