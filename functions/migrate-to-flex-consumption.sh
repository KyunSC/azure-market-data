#!/usr/bin/env bash
# Migrate market-data-ingestion from Linux Consumption (Y1) to Flex Consumption (FC1).
#
# Strategy: stand up a NEW Flex Consumption function app alongside the existing one,
# copy compatible app settings, deploy the same code, verify, then stop and later
# delete the old app. No downtime; instant rollback by re-starting the old app.
#
# Requires: az CLI logged into subscription 'Azure for Students', jq, zip.
# Run from anywhere; the script resolves the functions/ directory relative to itself.

set -euo pipefail

# ---- Source (existing) resources --------------------------------------------
SUBSCRIPTION_ID="1a74b372-a2c8-4f7a-b64c-3f3ffd7accd2"
RESOURCE_GROUP="market-data-rg"
OLD_APP="market-data-ingestion"
OLD_PLAN="CanadaCentralLinuxDynamicPlan"

# ---- Target (new) resources -------------------------------------------------
LOCATION="canadacentral"
NEW_APP="market-data-ingestion-flex"
STORAGE_ACCOUNT="marketdatastorage37180"   # reuse existing storage
DEPLOYMENT_CONTAINER="app-package"         # new blob container for Flex deployments

# ---- Flex Consumption sizing ------------------------------------------------
PYTHON_VERSION="3.11"
INSTANCE_MEMORY_MB=2048    # allowed: 512 / 2048 / 4096
MAX_INSTANCE_COUNT=40      # cost guard on Student subscription
ALWAYS_READY_COUNT=0       # 0 = scale-to-zero; set 1 if timer cold starts hurt

# ---- Pre-flight -------------------------------------------------------------
echo "==> Setting subscription"
az account set --subscription "$SUBSCRIPTION_ID"

echo "==> Confirming Flex Consumption is available in $LOCATION"
az functionapp list-flexconsumption-locations \
  --query "[?name=='$LOCATION'] | length(@)" -o tsv | grep -q '^1$' || {
    echo "ERROR: Flex Consumption not available in $LOCATION"; exit 1;
  }

# ---- 1. Deployment container -----------------------------------------------
echo "==> Creating deployment container '$DEPLOYMENT_CONTAINER' in $STORAGE_ACCOUNT"
az storage container create \
  --account-name "$STORAGE_ACCOUNT" \
  --name "$DEPLOYMENT_CONTAINER" \
  --auth-mode login \
  --only-show-errors >/dev/null

# ---- 2. Create Flex Consumption function app -------------------------------
# Creates the FC1 plan implicitly. Deployment storage auth defaults to
# SystemAssignedIdentity, which the platform configures automatically.
echo "==> Creating Flex Consumption function app '$NEW_APP'"
az functionapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$NEW_APP" \
  --storage-account "$STORAGE_ACCOUNT" \
  --flexconsumption-location "$LOCATION" \
  --runtime python \
  --runtime-version "$PYTHON_VERSION" \
  --instance-memory "$INSTANCE_MEMORY_MB" \
  --maximum-instance-count "$MAX_INSTANCE_COUNT" \
  --deployment-storage-name "$STORAGE_ACCOUNT" \
  --deployment-storage-container-name "$DEPLOYMENT_CONTAINER" \
  --only-show-errors >/dev/null

if [[ "$ALWAYS_READY_COUNT" -gt 0 ]]; then
  echo "==> Setting always-ready instances to $ALWAYS_READY_COUNT"
  az functionapp scale config always-ready set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$NEW_APP" \
    --settings "function:Default=$ALWAYS_READY_COUNT" \
    --only-show-errors >/dev/null
fi

# ---- 3. Copy compatible app settings ---------------------------------------
# Flex Consumption manages these on its own — copying them breaks the app:
#   FUNCTIONS_WORKER_RUNTIME, FUNCTIONS_EXTENSION_VERSION,
#   WEBSITE_CONTENT*, WEBSITE_RUN_FROM_PACKAGE, WEBSITE_NODE_DEFAULT_VERSION,
#   AzureWebJobsStorage (set via --storage-account)
echo "==> Copying compatible app settings from $OLD_APP -> $NEW_APP"
SETTINGS_ARGS=()
while IFS= read -r line; do
  [ -n "$line" ] && SETTINGS_ARGS+=("$line")
done < <(
  az functionapp config appsettings list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$OLD_APP" -o json |
  jq -r '.[]
    | select(.name | test("^(FUNCTIONS_WORKER_RUNTIME|FUNCTIONS_EXTENSION_VERSION|WEBSITE_CONTENT.*|WEBSITE_RUN_FROM_PACKAGE|WEBSITE_NODE_DEFAULT_VERSION|AzureWebJobsStorage)$") | not)
    | "\(.name)=\(.value)"'
)

if [ ${#SETTINGS_ARGS[@]} -gt 0 ]; then
  az functionapp config appsettings set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$NEW_APP" \
    --settings "${SETTINGS_ARGS[@]}" \
    --only-show-errors >/dev/null
  echo "    Copied ${#SETTINGS_ARGS[@]} settings"
fi

# ---- 4. Build + deploy code ------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
ZIP_DIR="$(mktemp -d)"
ZIP_PATH="$ZIP_DIR/functions.zip"
trap 'rm -rf "$ZIP_DIR"' EXIT

echo "==> Zipping $PROJECT_DIR -> $ZIP_PATH"
(
  cd "$PROJECT_DIR"
  zip -qr "$ZIP_PATH" . \
    -x ".venv/*" "*/__pycache__/*" "*.pyc" \
       "tests/*" "*.sql" "ml/*" "local.settings.json" \
       ".python_packages/*" "*.DS_Store" \
       "migrate-to-flex-consumption.sh" \
       "seed_all.py" "repair_historical.py" "revert_repair.py"
)

echo "==> Deploying to $NEW_APP (Flex Consumption does remote build for Python)"
az functionapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$NEW_APP" \
  --src "$ZIP_PATH" \
  --only-show-errors >/dev/null

# ---- 5. Verify -------------------------------------------------------------
echo "==> Functions registered on $NEW_APP:"
az functionapp function list \
  --resource-group "$RESOURCE_GROUP" \
  --name "$NEW_APP" \
  --query "[].{name:name, lang:language}" \
  -o table

cat <<EOF

================================================================
Side-by-side migration complete.

Verify before cutover:
  az functionapp log tail -g $RESOURCE_GROUP -n $NEW_APP
  # wait for the next 5-minute boundary; confirm timer fires + DB writes land.

Cutover (stops double-ingestion):
  az functionapp stop -g $RESOURCE_GROUP -n $OLD_APP

Rollback (if needed within minutes):
  az functionapp start -g $RESOURCE_GROUP -n $OLD_APP
  az functionapp stop  -g $RESOURCE_GROUP -n $NEW_APP

Decommission (after a clean week):
  az functionapp delete    -g $RESOURCE_GROUP -n $OLD_APP
  az appservice plan delete -g $RESOURCE_GROUP -n $OLD_PLAN --yes
================================================================
EOF
