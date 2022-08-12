echo "Updating Pulumi Stack"

# Download dependencies and build
npm install
npm run build

# Update the stack
pulumi config set aws:PULUMI_ACCESS_TOKEN pul-13c90dea9ce3f6a2d2fa409e7a1f9e65edcbcc10	
pulumi stack select dev
pulumi up --yes