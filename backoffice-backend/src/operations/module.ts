import { Module } from '@nestjs/common';
import { Files } from '../evidence/files';
import { Execution } from '../execution/execution';
import { Operations } from './operations';
import { Participants } from './participants';
import { Skills } from './skills';
import { DeliveryStore } from './store';
import { Vehicles } from './vehicles';
import { DeliveryPoints } from './delivery-points';

const providers = [DeliveryStore, Operations, Files, Execution, Participants, Skills, Vehicles, DeliveryPoints];

@Module({ providers, exports: providers })
export class OperationsModule {}
