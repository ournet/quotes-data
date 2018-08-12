
import DynamoDB = require('aws-sdk/clients/dynamodb');
import {
    BaseRepository,
    RepositoryUpdateData,
    RepositoryAccessOptions,
} from '@ournet/domain';

import {
    Quote,
    QuoteValidator,
    QuoteRepository,
    LatestQuotesQueryParams,
    LatestQuotesByTopicQueryParams,
    LatestQuotesByAuthorQueryParams,
    Topic,
} from '@ournet/quotes-domain';

import { QuoteModel } from './quote-model';
import { DynamoQuoteHelper } from './dynamo-quote';
import { TopicQuoteModel, TopicQuoteHelper } from './topic-quote-model';

export class DynamoQuoteRepository extends BaseRepository<Quote> implements QuoteRepository {
    protected model: QuoteModel
    protected topicQuoteModel: TopicQuoteModel

    constructor(client: DynamoDB.DocumentClient) {
        super(new QuoteValidator());
        this.model = new QuoteModel(client);
        this.topicQuoteModel = new TopicQuoteModel(client);
    }

    async innerCreate(data: Quote) {
        const item = DynamoQuoteHelper.mapFromQuote(data);
        const createdItem = await this.model.create(item);

        if (createdItem.topics) {
            await this.putTopicQuotes(createdItem.id, createdItem.lastFoundAt, createdItem.expiresAt, createdItem.topics);
        }

        return createdItem;
    }

    async innerUpdate(data: RepositoryUpdateData<Quote>) {
        const updatedItem = await this.model.update({
            remove: data.delete,
            key: { id: data.id },
            set: data.set && DynamoQuoteHelper.mapFromPartialQuote(data.set)
        });

        const item = DynamoQuoteHelper.mapToQuote(updatedItem);

        if (item.topics && item.topics.length && data.set && data.set.lastFoundAt) {
            await this.putTopicQuotes(item.id, item.lastFoundAt, item.expiresAt, item.topics);
        }

        return item;
    }

    async delete(id: string) {
        const oldItem = await this.model.delete({ id });
        return !!oldItem;
    }

    async exists(id: string) {
        const item = await this.getById(id, { fields: ['id'] });

        return !!item;
    }

    async getById(id: string, options?: RepositoryAccessOptions<Quote>) {
        const item = await this.model.get({ id }, options && { attributes: options.fields });

        if (!item) {
            return item;
        }

        return DynamoQuoteHelper.mapToQuote(item);
    }

    async getByIds(ids: string[], options?: RepositoryAccessOptions<Quote>) {
        const items = await this.model.getItems(ids.map(id => ({ id })), options && { attributes: options.fields });

        return items.map(item => DynamoQuoteHelper.mapToQuote(item));
    }

    async latest(params: LatestQuotesQueryParams, options?: RepositoryAccessOptions<Quote>) {
        const localeKey = DynamoQuoteHelper.createLocaleKey(params.country, params.lang);
        const result = await this.model.query({
            index: this.model.localeIndexName(),
            attributes: options && options.fields as string[] | undefined,
            hashKey: localeKey,
            limit: params.limit,
            startKey: params.lastFoundAt && { locale: localeKey, lastFoundAt: params.lastFoundAt } || undefined,
            // rangeKey: params.lastFoundAt && { operation: '>', value: params.lastFoundAt.toISOString() },
            order: 'DESC',
        });

        if (!result.items || result.items.length === 0) {
            return [];
        }

        return result.items.map(item => DynamoQuoteHelper.mapToQuote(item));
    }

    async latestByTopic(params: LatestQuotesByTopicQueryParams, options?: RepositoryAccessOptions<Quote>) {
        const result = await this.topicQuoteModel.query({
            index: this.topicQuoteModel.topicLastQuotesIndexName(),
            hashKey: params.topicId,
            limit: params.limit,
            startKey: params.lastFoundAt && { topicId: params.topicId, lastFoundAt: params.lastFoundAt } || undefined,
            order: 'DESC',
        });

        if (!result.items || result.items.length === 0) {
            return [];
        }

        const ids = result.items.map(item => item.quoteId);

        return this.getByIds(ids, options);
    }

    async latestByAuthor(params: LatestQuotesByAuthorQueryParams, options?: RepositoryAccessOptions<Quote>) {
        const result = await this.model.query({
            index: this.model.authorIndexName(),
            attributes: options && options.fields as string[] | undefined,
            hashKey: params.authorId,
            limit: params.limit,
            startKey: params.lastFoundAt && { authorId: params.authorId, lastFoundAt: params.lastFoundAt } || undefined,
            // rangeKey: params.lastFoundAt && { operation: '>', value: params.lastFoundAt.toISOString() },
            order: 'DESC',
        });

        if (!result.items || result.items.length === 0) {
            return [];
        }

        return result.items.map(item => DynamoQuoteHelper.mapToQuote(item));
    }

    protected async putTopicQuotes(quoteId: string, lastFoundAt: string, expiresAt: number, topics: Topic[]) {
        const items = TopicQuoteHelper.create(quoteId, lastFoundAt, expiresAt, topics);

        for (const item of items) {
            await this.topicQuoteModel.put(item);
        }
    }
}