-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "password" TEXT NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("provider","providerAccountId")
);

-- CreateTable
CREATE TABLE "Session" (
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("identifier","token")
);

-- CreateTable
CREATE TABLE "EbayToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nextSkuCounter" INTEGER NOT NULL DEFAULT 1,
    "skuPrefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkuSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EbayBusinessPolicies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentPolicyId" TEXT,
    "paymentPolicyName" TEXT,
    "returnPolicyId" TEXT,
    "returnPolicyName" TEXT,
    "fulfillmentPolicyId" TEXT,
    "fulfillmentPolicyName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayBusinessPolicies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BannedKeyword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BannedKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "minimumPrice" DOUBLE PRECISION NOT NULL DEFAULT 4.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverrideDescriptionSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "useOverrideDescription" BOOLEAN NOT NULL DEFAULT false,
    "overrideDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverrideDescriptionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditModeSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "defaultEditMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditModeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerNoteSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enableSellerNoteEditing" BOOLEAN NOT NULL DEFAULT false,
    "sellerNoteText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerNoteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allowOffers" BOOLEAN NOT NULL DEFAULT false,
    "minimumOfferAmount" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "EbayToken_userId_key" ON "EbayToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SkuSettings_userId_key" ON "SkuSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EbayBusinessPolicies_userId_key" ON "EbayBusinessPolicies"("userId");

-- CreateIndex
CREATE INDEX "BannedKeyword_userId_idx" ON "BannedKeyword"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BannedKeyword_userId_keyword_key" ON "BannedKeyword"("userId", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountSettings_userId_key" ON "DiscountSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OverrideDescriptionSettings_userId_key" ON "OverrideDescriptionSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EditModeSettings_userId_key" ON "EditModeSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerNoteSettings_userId_key" ON "SellerNoteSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferSettings_userId_key" ON "OfferSettings"("userId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayToken" ADD CONSTRAINT "EbayToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuSettings" ADD CONSTRAINT "SkuSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EbayBusinessPolicies" ADD CONSTRAINT "EbayBusinessPolicies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannedKeyword" ADD CONSTRAINT "BannedKeyword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountSettings" ADD CONSTRAINT "DiscountSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverrideDescriptionSettings" ADD CONSTRAINT "OverrideDescriptionSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditModeSettings" ADD CONSTRAINT "EditModeSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerNoteSettings" ADD CONSTRAINT "SellerNoteSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSettings" ADD CONSTRAINT "OfferSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

