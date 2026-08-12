-- CreateIndex
CREATE INDEX "Event_storeId_entityType_entityKey_occurredAt_idx" ON "Event"("storeId", "entityType", "entityKey", "occurredAt" DESC);
