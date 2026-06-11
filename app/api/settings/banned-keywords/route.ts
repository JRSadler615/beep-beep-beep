import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET: Fetch all banned keywords for the user
export async function GET() {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const bannedKeywords = await prisma.bannedKeyword.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    })

    return NextResponse.json({
      keywords: bannedKeywords.map((k: any) => ({
        id: k.id,
        keyword: k.keyword,
        createdAt: k.createdAt,
      })),
    })
  } catch (error) {
    console.error("Error fetching banned keywords:", error)
    return NextResponse.json(
      { error: "Failed to fetch banned keywords" },
      { status: 500 }
    )
  }
}

// POST: Add a new banned keyword
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
    const { keyword } = body

    if (!keyword || typeof keyword !== "string" || keyword.trim().length === 0) {
      return NextResponse.json(
        { error: "Keyword is required and must be a non-empty string" },
        { status: 400 }
      )
    }

    const trimmedKeyword = keyword.trim().toLowerCase()

    // Check if keyword already exists for this user
    const existing = await prisma.bannedKeyword.findUnique({
      where: {
        userId_keyword: {
          userId: session.user.id,
          keyword: trimmedKeyword,
        },
      },
    })

    if (existing) {
      return NextResponse.json(
        { error: "This keyword is already banned" },
        { status: 400 }
      )
    }

    // Create the banned keyword
    const bannedKeyword = await prisma.bannedKeyword.create({
      data: {
        userId: session.user.id,
        keyword: trimmedKeyword,
      },
    })

    return NextResponse.json({
      success: true,
      keyword: {
        id: bannedKeyword.id,
        keyword: bannedKeyword.keyword,
        createdAt: bannedKeyword.createdAt,
      },
    })
  } catch (error: any) {
    console.error("Error adding banned keyword:", error)
    
    // Handle unique constraint violation
    if (error.code === "P2002") {
      return NextResponse.json(
        { error: "This keyword is already banned" },
        { status: 400 }
      )
    }
    
    return NextResponse.json(
      { error: "Failed to add banned keyword", details: error.message },
      { status: 500 }
    )
  }
}

// DELETE: Remove a banned keyword
export async function DELETE(req: Request) {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json(
        { error: "Keyword ID is required" },
        { status: 400 }
      )
    }

    // Verify the keyword belongs to the user
    const bannedKeyword = await prisma.bannedKeyword.findUnique({
      where: { id },
    })

    if (!bannedKeyword) {
      return NextResponse.json(
        { error: "Keyword not found" },
        { status: 404 }
      )
    }

    if (bannedKeyword.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 403 }
      )
    }

    // Delete the keyword
    await prisma.bannedKeyword.delete({
      where: { id },
    })

    return NextResponse.json({
      success: true,
      message: "Keyword removed successfully",
    })
  } catch (error) {
    console.error("Error deleting banned keyword:", error)
    return NextResponse.json(
      { error: "Failed to delete banned keyword" },
      { status: 500 }
    )
  }
}
