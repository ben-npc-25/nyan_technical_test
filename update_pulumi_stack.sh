echo "Updating Pulumi Stack"

# Download dependencies and build
npm install pm2 -g
pm2 update
npm run build

# Update the stack
pulumi stack select dev
pulumi up --yes