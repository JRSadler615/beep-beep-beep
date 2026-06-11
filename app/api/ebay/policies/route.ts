import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  readErrorBody,
  getEbayBaseUrl,
  getValidEbayToken,
  debugLog,
} from "@/lib/ebay"

// GET: Fetch available eBay business policies
export async function GET() {
  try {
    const session = await auth()

    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Get a valid eBay access token (refreshes automatically if expired)
    const tokenResult = await getValidEbayToken(session.user.id)
    if (!tokenResult.ok) {
      return NextResponse.json(
        {
          error: tokenResult.error,
          needsReconnect: tokenResult.needsReconnect,
          details: tokenResult.details,
        },
        { status: tokenResult.status }
      )
    }
    const accessToken = tokenResult.accessToken

    const baseUrl = getEbayBaseUrl()

    // Use marketplace from env or default to EBAY_US
    const marketplace = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'

    debugLog("Fetching eBay policies from:", baseUrl, "marketplace:", marketplace)

    const policyHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
    }

    // Fetch all three policy types in parallel
    const [fulfillmentResponse, paymentResponse, returnResponse] = await Promise.all([
      fetch(`${baseUrl}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplace}`, { headers: policyHeaders }),
      fetch(`${baseUrl}/sell/account/v1/payment_policy?marketplace_id=${marketplace}`, { headers: policyHeaders }),
      fetch(`${baseUrl}/sell/account/v1/return_policy?marketplace_id=${marketplace}`, { headers: policyHeaders }),
    ])

    debugLog("Policy API responses:", {
      fulfillment: fulfillmentResponse.status,
      payment: paymentResponse.status,
      return: returnResponse.status
    })

    // Check for errors - a 401/403 on any policy type means the token is
    // missing the sell.account scope and the user must reconnect
    for (const [label, response] of [
      ["Fulfillment", fulfillmentResponse],
      ["Payment", paymentResponse],
      ["Return", returnResponse],
    ] as const) {
      if (!response.ok) {
        const { errorData } = await readErrorBody(response)
        console.error(`${label} policy error:`, errorData)

        if (response.status === 403 || response.status === 401) {
          return NextResponse.json(
            {
              error: "Missing required permissions. Please disconnect and reconnect your eBay account to grant 'sell.account' scope.",
              needsReconnect: true,
              details: errorData
            },
            { status: 403 }
          )
        }
      }
    }

    // Parse successful responses
    const fulfillmentData = fulfillmentResponse.ok ? await fulfillmentResponse.json() : { fulfillmentPolicies: [] }
    const paymentData = paymentResponse.ok ? await paymentResponse.json() : { paymentPolicies: [] }
    const returnData = returnResponse.ok ? await returnResponse.json() : { returnPolicies: [] }

    debugLog("Policies fetched:", {
      fulfillmentCount: fulfillmentData.fulfillmentPolicies?.length || 0,
      paymentCount: paymentData.paymentPolicies?.length || 0,
      returnCount: returnData.returnPolicies?.length || 0
    })

    // Format the policies for frontend consumption
    const policies = {
      fulfillmentPolicies: (fulfillmentData.fulfillmentPolicies || []).map((policy: any) => ({
        id: policy.fulfillmentPolicyId,
        name: policy.name,
        description: policy.description,
      })),
      paymentPolicies: (paymentData.paymentPolicies || []).map((policy: any) => ({
        id: policy.paymentPolicyId,
        name: policy.name,
        description: policy.description,
      })),
      returnPolicies: (returnData.returnPolicies || []).map((policy: any) => ({
        id: policy.returnPolicyId,
        name: policy.name,
        description: policy.description,
      })),
    }

    return NextResponse.json(policies)
  } catch (error) {
    console.error("Error fetching eBay policies:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch eBay policies",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}
