import { Request, Response } from 'express'
import * as fs from 'fs'
import { ICommonObject } from 'flowise-components'
import telemetryService from '../services/telemetry'
import logger from '../utils/logger'
import {
    buildFlow,
    constructGraphs,
    getAllConnectedNodes,
    mapMimeTypeToInputField,
    findMemoryNode,
    getMemorySessionId,
    getAppVersion,
    getTelemetryFlowObj,
    getStartingNodes
} from '../utils'
import { validateKey } from './validateKey'
import { IncomingInput, INodeDirectedGraph, IReactFlowObject, chatType } from '../Interface'
import { ChatFlow } from '../database/entities/ChatFlow'
import { getRunningExpressApp } from '../utils/getRunningExpressApp'

export const upsertVector = async (req: Request, res: Response, isInternal: boolean = false) => {
    try {
        const flowXpresApp = getRunningExpressApp()
        const chatflowid = req.params.id
        let incomingInput: IncomingInput = req.body

        const chatflow = await flowXpresApp.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowid
        })
        if (!chatflow) return res.status(404).send(`Chatflow ${chatflowid} not found`)

        if (!isInternal) {
            const isKeyValidated = await validateKey(req, chatflow)
            if (!isKeyValidated) return res.status(401).send('Unauthorized')
        }

        const files = (req.files as any[]) || []

        if (files.length) {
            const overrideConfig: ICommonObject = { ...req.body }
            for (const file of files) {
                const fileData = fs.readFileSync(file.path, { encoding: 'base64' })
                const dataBase64String = `data:${file.mimetype};base64,${fileData},filename:${file.filename}`

                const fileInputField = mapMimeTypeToInputField(file.mimetype)
                if (overrideConfig[fileInputField]) {
                    overrideConfig[fileInputField] = JSON.stringify([...JSON.parse(overrideConfig[fileInputField]), dataBase64String])
                } else {
                    overrideConfig[fileInputField] = JSON.stringify([dataBase64String])
                }
            }
            incomingInput = {
                question: req.body.question ?? 'hello',
                overrideConfig,
                history: [],
                stopNodeId: req.body.stopNodeId
            }
        }

        /*** Get chatflows and prepare data  ***/
        const flowData = chatflow.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = parsedFlowData.nodes
        const edges = parsedFlowData.edges

        let stopNodeId = incomingInput?.stopNodeId ?? ''
        let chatHistory = incomingInput?.history
        let chatId = incomingInput.chatId ?? ''
        let isUpsert = true

        // Get session ID
        const memoryNode = findMemoryNode(nodes, edges)
        let sessionId = undefined
        if (memoryNode) sessionId = getMemorySessionId(memoryNode, incomingInput, chatId, isInternal)

        const vsNodes = nodes.filter(
            (node) =>
                node.data.category === 'Vector Stores' && !node.data.label.includes('Upsert') && !node.data.label.includes('Load Existing')
        )
        if (vsNodes.length > 1 && !stopNodeId) {
            return res.status(500).send('There are multiple vector nodes, please provide stopNodeId in body request')
        } else if (vsNodes.length === 1 && !stopNodeId) {
            stopNodeId = vsNodes[0].data.id
        } else if (!vsNodes.length && !stopNodeId) {
            return res.status(500).send('No vector node found')
        }

        const { graph } = constructGraphs(nodes, edges, { isReversed: true })

        const nodeIds = getAllConnectedNodes(graph, stopNodeId)

        const filteredGraph: INodeDirectedGraph = {}
        for (const key of nodeIds) {
            if (Object.prototype.hasOwnProperty.call(graph, key)) {
                filteredGraph[key] = graph[key]
            }
        }

        const { startingNodeIds, depthQueue } = getStartingNodes(filteredGraph, stopNodeId)

        await buildFlow(
            startingNodeIds,
            nodes,
            edges,
            filteredGraph,
            depthQueue,
            flowXpresApp.nodesPool.componentNodes,
            incomingInput.question,
            chatHistory,
            chatId,
            sessionId ?? '',
            chatflowid,
            flowXpresApp.AppDataSource,
            incomingInput?.overrideConfig,
            flowXpresApp.cachePool,
            isUpsert,
            stopNodeId
        )

        const startingNodes = nodes.filter((nd) => startingNodeIds.includes(nd.data.id))

        flowXpresApp.chatflowPool.add(chatflowid, undefined, startingNodes, incomingInput?.overrideConfig)
        await telemetryService.createEvent({
            name: `vector_upserted`,
            data: {
                version: await getAppVersion(),
                chatlowId: chatflowid,
                type: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
                flowGraph: getTelemetryFlowObj(nodes, edges),
                stopNodeId
            }
        })
        return res.status(201).send('Successfully Upserted')
    } catch (e: any) {
        logger.error('[server]: Error:', e)
        return res.status(500).send(e.message)
    }
}