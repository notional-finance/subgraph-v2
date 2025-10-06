#!/bin/python
import requests

endpoint = 'https://api.studio.thegraph.com/query/36749/notional-v3-arbitrum/version/latest'

def get_accounts_page(skip=0):
    # Your GraphQL query
    query = """
    {
      accounts(first: 1000, skip: %s) { 
        id
      }
    }
    """ % (skip)

    response = requests.post(endpoint, json={"query": query})
    return response.json()["data"]["accounts"]

def check_account(a):
    query = """
    {
        account(id: "%s") {
            id
            systemAccountType
            profitLossLineItems(
                first: 1000, orderBy: blockNumber, orderDirection: desc
            ) {
                bundle { bundleName }
            }
        }
    }
    """ % (a)

    response = requests.post(endpoint, json={"query": query})
    try:
        return response.json()["data"]["account"]["id"]
    except:
        print("Error Processing:", a)
        print(response)


def paginate_accounts():
    all_accounts = []
    skip = 0

    while True:
        result = get_accounts_page(skip)

        if not result:
            break

        accounts = result
        all_accounts.extend(accounts)

        # Increment the skip value for the next page
        skip += len(accounts)

    return all_accounts

all_accounts = paginate_accounts()
print("all accounts", len(all_accounts))
for a in all_accounts:
    check_account(a['id'])
