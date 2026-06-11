import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET: Fetch current override description settings for the user
export async function GET() {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Get or create override description settings for the user
    let overrideSettings = await prisma.overrideDescriptionSettings.findUnique({
      where: { userId: session.user.id }
    })

    // If no settings exist, create default ones
    if (!overrideSettings) {
      overrideSettings = await prisma.overrideDescriptionSettings.create({
        data: {
          userId: session.user.id,
          useOverrideDescription: false,
          overrideDescription: null,
        }
      })
    }

    return NextResponse.json({
      useOverrideDescription: overrideSettings.useOverrideDescription,
      overrideDescription: overrideSettings.overrideDescription || "",
    })
  } catch (error) {
    console.error("Error fetching override description settings:", error)
    return NextResponse.json(
      { error: "Failed to fetch override description settings" },
      { status: 500 }
    )
  }
}

// POST: Update override description settings
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
    const { useOverrideDescription, overrideDescription } = body

    // Validate useOverrideDescription if provided
    if (useOverrideDescription !== undefined && typeof useOverrideDescription !== 'boolean') {
      return NextResponse.json(
        { error: "useOverrideDescription must be a boolean value" },
        { status: 400 }
      )
    }

    // Validate overrideDescription if provided
    if (overrideDescription !== undefined && typeof overrideDescription !== 'string') {
      return NextResponse.json(
        { error: "overrideDescription must be a string value" },
        { status: 400 }
      )
    }

    // Update or create settings
    const updated = await prisma.overrideDescriptionSettings.upsert({
      where: { userId: session.user.id },
      update: {
        ...(useOverrideDescription !== undefined && { useOverrideDescription }),
        ...(overrideDescription !== undefined && { overrideDescription: overrideDescription || null }),
      },
      create: {
        userId: session.user.id,
        useOverrideDescription: useOverrideDescription !== undefined ? useOverrideDescription : false,
        overrideDescription: overrideDescription || null,
      }
    })

    return NextResponse.json({
      success: true,
      useOverrideDescription: updated.useOverrideDescription,
      overrideDescription: updated.overrideDescription || "",
    })
  } catch (error) {
    console.error("Error updating override description settings:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to update override description settings", details: errorMessage },
      { status: 500 }
    )
  }
}

