AWS_REGION ?= eu-west-1
STACK_NAME ?= Video

.PHONY: install test synth diff deploy set-secrets outputs smoke

install:
	npm ci

test:
	npm test -- --runInBand

synth:
	AWS_REGION=$(AWS_REGION) npm run synth -- --quiet

diff:
	AWS_REGION=$(AWS_REGION) npm run diff

deploy: test
	AWS_REGION=$(AWS_REGION) npm run deploy

# Prompts for the Microsoft Entra app's tenant ID, client ID and client secret and stores them in SSM.
set-secrets:
	AWS_REGION=$(AWS_REGION) scripts/set-secrets.sh

outputs:
	aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table

# End-to-end test against the deployed site. Uploads, checks and deletes a throwaway unlisted video.
smoke:
	AWS_REGION=$(AWS_REGION) node scripts/smoke-test.js
