import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// GET: Fetch user's saved eBay business policy preferences
export async function GET() {
  try {
    const session = await auth()
    
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Get user's saved policies
    const policies = await prisma.ebayBusinessPolicies.findUnique({
      where: { userId: session.user.id }
    })

    if (!policies) {
      return NextResponse.json({
        paymentPolicyId: null,
        paymentPolicyName: null,
        returnPolicyId: null,
        returnPolicyName: null,
        fulfillmentPolicyId: null,
        fulfillmentPolicyName: null,
      })
    }

    return NextResponse.json({
      paymentPolicyId: policies.paymentPolicyId,
      paymentPolicyName: policies.paymentPolicyName,
      returnPolicyId: policies.returnPolicyId,
      returnPolicyName: policies.returnPolicyName,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      fulfillmentPolicyName: policies.fulfillmentPolicyName,
    })
  } catch (error) {
    console.error("Error fetching eBay policy preferences:", error)
    return NextResponse.json(
      { error: "Failed to fetch eBay policy preferences" },
      { status: 500 }
    )
  }
}

// POST: Save user's eBay business policy preferences
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
    const {
      paymentPolicyId,
      paymentPolicyName,
      returnPolicyId,
      returnPolicyName,
      fulfillmentPolicyId,
      fulfillmentPolicyName,
    } = body

    // Upsert (create or update) the policies
    const policies = await prisma.ebayBusinessPolicies.upsert({
      where: { userId: session.user.id },
      update: {
        paymentPolicyId,
        paymentPolicyName,
        returnPolicyId,
        returnPolicyName,
        fulfillmentPolicyId,
        fulfillmentPolicyName,
        updatedAt: new Date(),
      },
      create: {
        userId: session.user.id,
        paymentPolicyId,
        paymentPolicyName,
        returnPolicyId,
        returnPolicyName,
        fulfillmentPolicyId,
        fulfillmentPolicyName,
      }
    })

    return NextResponse.json({
      success: true,
      paymentPolicyId: policies.paymentPolicyId,
      paymentPolicyName: policies.paymentPolicyName,
      returnPolicyId: policies.returnPolicyId,
      returnPolicyName: policies.returnPolicyName,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      fulfillmentPolicyName: policies.fulfillmentPolicyName,
    })
  } catch (error) {
    console.error("Error saving eBay policy preferences:", error)
    return NextResponse.json(
      { 
        error: "Failed to save eBay policy preferences",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

