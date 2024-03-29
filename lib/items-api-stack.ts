import * as cdk from '@aws-cdk/core';
import * as cognito from '@aws-cdk/aws-cognito';
import * as iam from '@aws-cdk/aws-iam';
import * as appsync from '@aws-cdk/aws-appsync';
import * as ddb from '@aws-cdk/aws-dynamodb';
import * as lambda from '@aws-cdk/aws-lambda';

export class ItemsApiStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    // user pool
    const userPool = new cognito.UserPool(this, 'UserPoolAtItems', {
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      signInAliases: { email: true }
    });

    // user pool client
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClientAtItems', {
      userPool,
      generateSecret: false
    });

    // user identity pool
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPoolAtItems', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName
        }
      ]
    });

    // iam role
    const role = new iam.Role(this, 'AppsyncIamRoleAtItems', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      )
    });

    // role policy
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'mobileanalytics:PutEvents',
          'cognito-sync:*',
          'cognito-identity:*',
        ],
        resources: ['*']
      })
    );

    // identity pool role attachemnt
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachmentAtItems', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: role.roleArn }
    });

    // print cognito
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
    });
    new cdk.CfnOutput(this, 'AuthenticatedRoleName', {
      value: role.roleName
    });

    // api
    const api = new appsync.GraphqlApi(this, 'Api', {
      name: 'items-api',
      schema: appsync.Schema.fromAsset('graphql/schema.graphql'),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.API_KEY,
            apiKeyConfig: {
              expires: cdk.Expiration.after(cdk.Duration.days(365))
            }
          }
        ]
      },
      xrayEnabled: true
    });

    // api access with iam role
    // api.grant(role, appsync.IamResource.custom('types/Query/listItems'), 'appsync:GraphQL'); // ('types/Query/fields/listItems'), 'appsync:GraphQL')
    api.grantQuery(role, 'listItems');
    api.grantQuery(role, 'getItemById');
    api.grantQuery(role, 'getItemBySerialNumber');
    api.grantMutation(role, 'createItem');
    api.grantMutation(role, 'updateItem');
    api.grantMutation(role, 'deleteItem');

    // lambda data source and resolvers
    const itemsLambda = new lambda.Function(this, 'AppsyncItemsHandler', {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'appsync-ds-main.handler',
      code: lambda.Code.fromAsset('lambda-fns'),
      memorySize: 1024
    });

    const lambdaDs = api.addLambdaDataSource('lambdaDatasource', itemsLambda);

    lambdaDs.createResolver({
      typeName: "Query",
      fieldName: "getItemById"
    });

    lambdaDs.createResolver({
      typeName: "Query",
      fieldName: "getItemBySerialNumber"
    });
    
    lambdaDs.createResolver({
      typeName: "Query",
      fieldName: "listItems"
    });
    
    lambdaDs.createResolver({
      typeName: "Mutation",
      fieldName: "createItem"
    });
    
    lambdaDs.createResolver({
      typeName: "Mutation",
      fieldName: "deleteItem"
    });
    
    lambdaDs.createResolver({
      typeName: "Mutation",
      fieldName: "updateItem"
    });

    // ddb table
    const itemsTable = new ddb.Table(this, 'CDKItemsTable', {
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: 'id',
        type: ddb.AttributeType.STRING
      }
    });

    // ddb GSI to query by serialNumber
    itemsTable.addGlobalSecondaryIndex({
      indexName: 'serialNumberIndex',
      partitionKey: {
        name: 'serialNumber',
        type: ddb.AttributeType.STRING
      },
      sortKey: {
        name: 'dateCreatedAt',
        type: ddb.AttributeType.STRING
      }
    });

    // ddb table access from lambda
    itemsTable.grantFullAccess(itemsLambda);

    // env variable for ddb table
    itemsLambda.addEnvironment('ITEMS_TABLE', itemsTable.tableName);

    // print api
    new cdk.CfnOutput(this, 'GraphQLAPIURL', {
      value: api.graphqlUrl
    });

    new cdk.CfnOutput(this, 'GraphQLAPIKEY', {
      value: api.apiKey || ''
    });

    new cdk.CfnOutput(this, 'ItemsApiStack Region', {
      value: this.region
    });
  }
}
